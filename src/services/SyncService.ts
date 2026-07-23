import * as SecureStore from 'expo-secure-store';
import * as Application from 'expo-application';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import { ApiClient, ApiError } from './ApiClient';
import { DatabaseService, User } from './DatabaseService';
import {
  AUXILIARY_UPLOAD_BATCH_SIZE,
  AUXILIARY_UPLOAD_MAX_BATCHES_PER_SYNC,
  SCAN_UPLOAD_BATCH_SIZE,
  SCAN_UPLOAD_MAX_BATCHES_PER_SYNC,
} from '../config';
import { OfflineSessionService } from './OfflineSessionService';

const CURRENT_EVENT_ID_KEY = 'verigate_scan_event_id';
const CURRENT_EVENT_NAME_KEY = 'verigate_scan_event_name';
const LAST_SYNC_AT_KEY = 'verigate_scan_last_sync_at';
const FALLBACK_DEVICE_ID_KEY = 'verigate_scan_fallback_device_id';

interface RemoteEvent {
  id: number;
  name: string;
  ends_at: string | null;
}

export interface SyncResult {
  success: boolean;
  eventId?: number;
  eventName?: string;
  userCount?: number;
  areaCount?: number;
  uploadedScans?: number;
  error?: string;
}

interface QueueAckResponse {
  contract_version: 'queue-ack-v2';
  results: {
    client_record_id: string;
    status: 'accepted' | 'duplicate' | 'rejected' | 'retryable_error';
    error?: string;
  }[];
}

interface RecordAckResponse {
  contract_version: 'queue-ack-v2';
  client_record_id: string;
  status: 'accepted' | 'duplicate';
}

interface AuxiliaryUploadResult {
  success: boolean;
  uploaded: number;
  error?: string;
}

/** Retries a flaky network call with exponential backoff for resilience. */
async function withBackoff<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** i));
      }
    }
  }
  throw lastError;
}

class SyncServiceClass {
  private deviceId: string | null = null;
  private inFlight: Promise<SyncResult> | null = null;

  async getDeviceId(): Promise<string> {
    if (this.deviceId) return this.deviceId;
    const platformId = Platform.OS === 'android'
      ? Application.getAndroidId()
      : await Application.getIosIdForVendorAsync();
    if (platformId) {
      this.deviceId = platformId;
      return this.deviceId;
    }
    this.deviceId = await SecureStore.getItemAsync(FALLBACK_DEVICE_ID_KEY);
    if (!this.deviceId) {
      this.deviceId = `scan-${Crypto.randomUUID()}`;
      await SecureStore.setItemAsync(FALLBACK_DEVICE_ID_KEY, this.deviceId);
    }
    return this.deviceId;
  }

  async getCurrentEventId(): Promise<number | null> {
    const stored = await SecureStore.getItemAsync(CURRENT_EVENT_ID_KEY);
    return stored ? Number(stored) : null;
  }

  async getCurrentEventName(): Promise<string | null> {
    return SecureStore.getItemAsync(CURRENT_EVENT_NAME_KEY);
  }

  async getLastSyncAt(): Promise<number | null> {
    const stored = await SecureStore.getItemAsync(LAST_SYNC_AT_KEY);
    return stored ? Number(stored) : null;
  }

  /** Pulls the selected event and uploads queued records under the event
   * captured when each record was created. On failure the last trusted
   * snapshot remains available for a bounded offline session. */
  async syncNow(): Promise<SyncResult> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.performSync().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async performSync(): Promise<SyncResult> {
    try {
      if (!ApiClient.isAuthenticated()) {
        return { success: false, error: 'Not authenticated with backend' };
      }

      const events = await withBackoff(() => ApiClient.request<RemoteEvent[]>('/events'));
      if (events.length === 0) {
        return { success: false, error: 'No events assigned to this scanner account yet' };
      }

      let eventId = await this.getCurrentEventId();
      const event = events.find((e) => e.id === eventId) ?? events[0];
      eventId = event.id;

      const [usersData, areasData] = await Promise.all([
        withBackoff(() => ApiClient.request<{ contract_version: string; users: User[] }>('/sync/users-database', { params: { event_id: eventId! } })),
        withBackoff(() => ApiClient.request<{
          areas: { id: number; name: string; requires_scan: boolean }[];
          qr_authority_public_key: string;
        }>('/sync/areas-database', { params: { event_id: eventId! } })),
      ]);

      await DatabaseService.upsertSyncedUsers(eventId, usersData.users);
      await DatabaseService.upsertSyncedAreas(eventId, areasData.areas);
      await DatabaseService.setQrAuthorityPublicKey(eventId, areasData.qr_authority_public_key);

      if (event.ends_at) {
        await DatabaseService.purgeIfEventExpired(new Date(event.ends_at).getTime());
      }

      const uploadedScans = await this.uploadQueuedScans();
      const incidentUpload = await this.uploadQueuedIncidents();
      if (!incidentUpload.success) {
        return {
          success: false,
          eventId,
          eventName: event.name,
          userCount: usersData.users.length,
          areaCount: areasData.areas.length,
          uploadedScans,
          error: incidentUpload.error ?? 'Incident queue upload did not complete safely',
        };
      }
      const overrideUpload = await this.uploadQueuedOverrides();
      if (!overrideUpload.success) {
        return {
          success: false,
          eventId,
          eventName: event.name,
          userCount: usersData.users.length,
          areaCount: areasData.areas.length,
          uploadedScans,
          error: overrideUpload.error ?? 'Override queue upload did not complete safely',
        };
      }

      await SecureStore.setItemAsync(CURRENT_EVENT_ID_KEY, String(eventId));
      await SecureStore.setItemAsync(CURRENT_EVENT_NAME_KEY, event.name);
      await SecureStore.setItemAsync(LAST_SYNC_AT_KEY, String(Date.now()));

      const deviceId = await this.getDeviceId();
      const tokenBinding = ApiClient.getTokenBinding();
      if (tokenBinding) {
        await OfflineSessionService.refreshProductionBinding({ eventId, deviceId, tokenBinding });
      }
      await ApiClient.request('/notifications/sync-heartbeat', {
        method: 'POST',
        body: { device_id: deviceId, app: 'scan', event_id: eventId, platform: Platform.OS },
      }).catch(() => undefined);

      return {
        success: true,
        eventId,
        eventName: event.name,
        userCount: usersData.users.length,
        areaCount: areasData.areas.length,
        uploadedScans,
      };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Sync failed' };
    }
  }

  private async uploadQueuedScans(): Promise<number> {
    let totalUploaded = 0;
    const deviceId = await this.getDeviceId();
    const maximumBatches = SCAN_UPLOAD_MAX_BATCHES_PER_SYNC ?? 1;

    for (let batchNumber = 0; batchNumber < maximumBatches; batchNumber += 1) {
      const pending = await DatabaseService.getUnsyncedScanLogs(SCAN_UPLOAD_BATCH_SIZE);
      if (pending.length === 0) break;

      const groups = new Map<number, typeof pending>();
      pending.forEach((record) => {
        const group = groups.get(record.event_id) ?? [];
        group.push(record);
        groups.set(record.event_id, group);
      });

      let uploadedThisBatch = 0;
      let receivedRetryableFailure = false;
      for (const [eventId, records] of groups) {
        const logs = records.map((log) => ({
          client_record_id: log.device_scan_id,
          event_id: log.event_id,
          user_id: log.user_id,
          area_id: log.area_id,
          access_granted: log.access_granted,
          failure_reason: log.failure_reason,
          scanned_at: log.scanned_at,
          device_scan_id: log.device_scan_id,
        }));

        const response = await withBackoff(() =>
          ApiClient.request<QueueAckResponse>('/sync/scan-logs', {
            method: 'POST',
            body: { logs, device_id: deviceId, event_id: eventId },
          })
        );
        const acknowledged = new Set(
          response.results
            .filter((item) => item.status === 'accepted' || item.status === 'duplicate')
            .map((item) => item.client_record_id)
        );
        receivedRetryableFailure ||= response.results.some((item) => item.status === 'retryable_error');
        const ids = records
          .filter((item) => item.device_scan_id && acknowledged.has(item.device_scan_id))
          .map((item) => item.id);
        await DatabaseService.markScanLogsSynced(ids);
        uploadedThisBatch += ids.length;
      }

      totalUploaded += uploadedThisBatch;
      if (
        pending.length < SCAN_UPLOAD_BATCH_SIZE
        || receivedRetryableFailure
        || uploadedThisBatch === 0
      ) break;
    }
    return totalUploaded;
  }

  private isAcceptedAcknowledgement(response: RecordAckResponse, clientRecordId: string): boolean {
    return response.contract_version === 'queue-ack-v2'
      && response.client_record_id === clientRecordId
      && (response.status === 'accepted' || response.status === 'duplicate');
  }

  private isTerminalRejection(error: unknown): error is ApiError {
    return error instanceof ApiError
      && error.statusCode >= 400
      && error.statusCode < 500
      && error.statusCode !== 401
      && error.statusCode !== 403
      && error.responseData?.contract_version === 'queue-ack-v2'
      && error.responseData.status === 'rejected';
  }

  private isSessionFailure(error: unknown): error is ApiError {
    return error instanceof ApiError && (error.statusCode === 401 || error.statusCode === 403);
  }

  private queueError(error: unknown): string {
    return error instanceof Error ? error.message : 'Queue upload failed';
  }

  private async uploadQueuedIncidents(): Promise<AuxiliaryUploadResult> {
    let totalUploaded = 0;
    for (let batch = 0; batch < AUXILIARY_UPLOAD_MAX_BATCHES_PER_SYNC; batch += 1) {
      const pending = await DatabaseService.getUnsyncedIncidents(AUXILIARY_UPLOAD_BATCH_SIZE);
      if (pending.length === 0) break;
      let progress = 0;

      for (const incident of pending) {
        try {
          const response = await ApiClient.request<RecordAckResponse>('/incidents', {
            method: 'POST',
            body: {
              client_record_id: incident.client_record_id,
              event_id: incident.event_id,
              category: incident.category,
              description: incident.description,
              area_id: incident.area_id ?? undefined,
              occurred_at: incident.occurred_at,
            },
          });
          if (!this.isAcceptedAcknowledgement(response, incident.client_record_id)) {
            await DatabaseService.recordIncidentFailure(incident.id, 'Invalid queue acknowledgement', false);
            return { success: false, uploaded: totalUploaded, error: 'Incident acknowledgement was invalid' };
          }
          await DatabaseService.markIncidentsSynced([incident.id]);
          totalUploaded += 1;
          progress += 1;
        } catch (error) {
          if (this.isSessionFailure(error)) {
            return { success: false, uploaded: totalUploaded, error: 'Incident upload requires a valid session' };
          }
          if (this.isTerminalRejection(error)) {
            await DatabaseService.recordIncidentFailure(incident.id, this.queueError(error), true);
            progress += 1;
            continue;
          }
          await DatabaseService.recordIncidentFailure(incident.id, this.queueError(error), false);
          return { success: false, uploaded: totalUploaded, error: 'Incident upload will retry later' };
        }
      }

      if (pending.length < AUXILIARY_UPLOAD_BATCH_SIZE) break;
      if (progress === 0) {
        return { success: false, uploaded: totalUploaded, error: 'Incident queue made no progress' };
      }
    }
    return { success: true, uploaded: totalUploaded };
  }

  private async uploadQueuedOverrides(): Promise<AuxiliaryUploadResult> {
    let totalUploaded = 0;
    for (let batch = 0; batch < AUXILIARY_UPLOAD_MAX_BATCHES_PER_SYNC; batch += 1) {
      const pending = await DatabaseService.getUnsyncedOverrides(AUXILIARY_UPLOAD_BATCH_SIZE);
      if (pending.length === 0) break;
      let progress = 0;

      for (const override of pending) {
        if (!override.area_id) {
          await DatabaseService.recordOverrideFailure(override.id, 'Queued override is missing area_id', true);
          progress += 1;
          continue;
        }

        try {
          // Resolve the attendee identity within the event captured when the
          // record was created; never substitute the currently selected event.
          let userId: number | undefined;
          if (override.user_email) {
            const user = await DatabaseService.getUserByEmail(override.user_email, override.event_id);
            userId = user?.id;
          }
          const response = await ApiClient.request<RecordAckResponse>('/incidents/overrides', {
            method: 'POST',
            body: {
              client_record_id: override.client_record_id,
              event_id: override.event_id,
              area_id: override.area_id,
              access_granted: override.access_granted,
              reason: override.reason,
              user_id: userId,
              occurred_at: override.occurred_at,
            },
          });
          if (!this.isAcceptedAcknowledgement(response, override.client_record_id)) {
            await DatabaseService.recordOverrideFailure(override.id, 'Invalid queue acknowledgement', false);
            return { success: false, uploaded: totalUploaded, error: 'Override acknowledgement was invalid' };
          }
          await DatabaseService.markOverridesSynced([override.id]);
          totalUploaded += 1;
          progress += 1;
        } catch (error) {
          if (this.isSessionFailure(error)) {
            return { success: false, uploaded: totalUploaded, error: 'Override upload requires a valid session' };
          }
          if (this.isTerminalRejection(error)) {
            await DatabaseService.recordOverrideFailure(override.id, this.queueError(error), true);
            progress += 1;
            continue;
          }
          await DatabaseService.recordOverrideFailure(override.id, this.queueError(error), false);
          return { success: false, uploaded: totalUploaded, error: 'Override upload will retry later' };
        }
      }

      if (pending.length < AUXILIARY_UPLOAD_BATCH_SIZE) break;
      if (progress === 0) {
        return { success: false, uploaded: totalUploaded, error: 'Override queue made no progress' };
      }
    }
    return { success: true, uploaded: totalUploaded };
  }
}

export const SyncService = new SyncServiceClass();
