import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import { ApiClient, ApiError } from './ApiClient';
import { DatabaseService, QrTrustPage, User } from './DatabaseService';
import {
  AUXILIARY_UPLOAD_BATCH_SIZE,
  AUXILIARY_UPLOAD_MAX_BATCHES_PER_SYNC,
  SCAN_UPLOAD_BATCH_SIZE,
  SCAN_UPLOAD_MAX_BATCHES_PER_SYNC,
} from '../config';
import { OfflineSessionService } from './OfflineSessionService';
import { DeviceIdentityService } from './DeviceIdentityService';

const CURRENT_EVENT_ID_KEY = 'verigate_scan_event_id';
const CURRENT_EVENT_NAME_KEY = 'verigate_scan_event_name';
const CURRENT_EVENT_STARTS_AT_KEY = 'verigate_scan_event_starts_at';
const CURRENT_EVENT_ENDS_AT_KEY = 'verigate_scan_event_ends_at';
const CURRENT_EVENT_ACTIVE_KEY = 'verigate_scan_event_active';
const LAST_SYNC_AT_KEY = 'verigate_scan_last_sync_at';

export interface RemoteEvent {
  id: number;
  name: string;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
}

export interface SyncResult {
  success: boolean;
  eventId?: number;
  eventName?: string;
  userCount?: number;
  areaCount?: number;
  uploadedScans?: number;
  error?: string;
  deviceControlReason?: 'deregistered' | 'blacklisted';
}

export interface DeregisteredAuditSession {
  eventId: number;
  cutoff: string;
  deadline: string;
  accessToken: string;
}

interface QueueAckResponse {
  contract_version: 'queue-ack-v2';
  results: {
    client_record_id: string;
    status: 'accepted' | 'duplicate' | 'rejected' | 'retryable_error';
    error?: string;
    server_id?: number;
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

/** Retries only bounded dependency failures; session and validation failures are terminal. */
async function withBackoff<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (
        error instanceof ApiError &&
        error.kind !== 'timeout' &&
        error.kind !== 'network' &&
        error.statusCode < 500
      ) {
        throw error;
      }
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** i));
      }
    }
  }
  throw lastError;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function verifyTrustChecksum(page: QrTrustPage): Promise<void> {
  const { checksum, ...normalized } = page;
  const actual = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    canonical(normalized),
    { encoding: Crypto.CryptoEncoding.HEX }
  );
  if (!/^[a-f0-9]{64}$/.test(checksum) || actual !== checksum) {
    throw new Error('QR trust page checksum is invalid');
  }
}

class SyncServiceClass {
  private inFlight: Promise<SyncResult> | null = null;

  async getDeviceId(): Promise<string> {
    return DeviceIdentityService.getInstallationId();
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

  async selectEvent(event: RemoteEvent): Promise<void> {
    if (!Number.isSafeInteger(event.id) || event.id <= 0) {
      throw new Error('Selected event is invalid');
    }
    await Promise.all([
      SecureStore.setItemAsync(CURRENT_EVENT_ID_KEY, String(event.id)),
      SecureStore.setItemAsync(CURRENT_EVENT_NAME_KEY, event.name),
      event.starts_at
        ? SecureStore.setItemAsync(CURRENT_EVENT_STARTS_AT_KEY, event.starts_at)
        : SecureStore.deleteItemAsync(CURRENT_EVENT_STARTS_AT_KEY),
      event.ends_at
        ? SecureStore.setItemAsync(CURRENT_EVENT_ENDS_AT_KEY, event.ends_at)
        : SecureStore.deleteItemAsync(CURRENT_EVENT_ENDS_AT_KEY),
      SecureStore.setItemAsync(CURRENT_EVENT_ACTIVE_KEY, event.is_active ? 'true' : 'false'),
    ]);
  }

  async clearEventSelection(): Promise<void> {
    await Promise.all([
      SecureStore.deleteItemAsync(CURRENT_EVENT_ID_KEY),
      SecureStore.deleteItemAsync(CURRENT_EVENT_NAME_KEY),
      SecureStore.deleteItemAsync(CURRENT_EVENT_STARTS_AT_KEY),
      SecureStore.deleteItemAsync(CURRENT_EVENT_ENDS_AT_KEY),
      SecureStore.deleteItemAsync(CURRENT_EVENT_ACTIVE_KEY),
      SecureStore.deleteItemAsync(LAST_SYNC_AT_KEY),
    ]);
  }

  private async performSync(): Promise<SyncResult> {
    try {
      if (!ApiClient.isAuthenticated()) {
        return { success: false, error: 'Not authenticated with backend' };
      }

      if (!ApiClient.hasDeviceSession()) {
        return {
          success: false,
          error: 'Select an event with an account session before scanner synchronization',
        };
      }
      const eventId = ApiClient.getDeviceEventId();
      if (!eventId) {
        return { success: false, error: 'Device session has no validated event binding' };
      }
      const event: RemoteEvent = {
        id: eventId,
        name: await this.getCurrentEventName() ?? `Event ${eventId}`,
        starts_at: await SecureStore.getItemAsync(CURRENT_EVENT_STARTS_AT_KEY),
        ends_at: await SecureStore.getItemAsync(CURRENT_EVENT_ENDS_AT_KEY),
        is_active: (await SecureStore.getItemAsync(CURRENT_EVENT_ACTIVE_KEY)) === 'true',
      };

      const [usersData, areasData] = await Promise.all([
        withBackoff(() => ApiClient.request<{ contract_version: string; users: User[] }>('/sync/users-database', { params: { event_id: eventId! } })),
        withBackoff(() => ApiClient.request<{
          areas: { id: number; name: string; requires_scan: boolean }[];
          qr_authority_public_key: string;
        }>('/sync/areas-database', { params: { event_id: eventId! } })),
      ]);

      const trustGeneration = await this.syncQrTrust(eventId);
      await DatabaseService.promoteAuthorizationSnapshot({
        eventId,
        event: {
          name: event.name,
          is_active: event.is_active,
          starts_at: event.starts_at,
          ends_at: event.ends_at,
        },
        trustGeneration,
        users: usersData.users,
        areas: areasData.areas,
        legacyAuthorityPublicKey: areasData.qr_authority_public_key,
      });

      if (event.ends_at) {
        await DatabaseService.purgeIfEventExpired(new Date(event.ends_at).getTime());
      }

      await this.drainTransitionAuditQueues();
      const uploadedScans = await this.uploadQueuedScans(eventId);
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
        timeoutMs: 5_000,
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
      const deviceControlReason = error instanceof ApiError
        ? (
          error.code === 'DEVICE_BLACKLISTED'
            ? 'blacklisted'
            : error.code?.startsWith('DEVICE_') ? 'deregistered' : undefined
        )
        : undefined;
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Sync failed',
        deviceControlReason,
      };
    }
  }

  private async syncQrTrust(eventId: number): Promise<number> {
    let cursor: string | undefined;
    let snapshotGeneration: number | null = null;
    for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
      const page = await withBackoff(() => ApiClient.request<QrTrustPage>(
        '/sync/qr-trust',
        { params: { event_id: eventId, limit: 200, ...(cursor ? { cursor } : {}) } }
      ));
      await verifyTrustChecksum(page);
      if (page.event_id !== eventId) throw new Error('QR trust page belongs to another event');
      if (snapshotGeneration == null) snapshotGeneration = page.snapshot_generation;
      if (page.snapshot_generation !== snapshotGeneration) {
        throw new Error('QR trust snapshot changed during pagination');
      }
      await DatabaseService.stageQrTrustPage(page, pageNumber === 0);
      if (!page.has_more) {
        return snapshotGeneration;
      }
      if (!page.next_cursor || page.next_cursor === cursor) {
        throw new Error('QR trust pagination did not advance');
      }
      cursor = page.next_cursor;
    }
    throw new Error('QR trust synchronization exceeded 100 pages');
  }

  async drainDeregisteredAuditQueues(
    session: DeregisteredAuditSession
  ): Promise<{ uploaded: number }> {
    if (Date.now() >= new Date(session.deadline).getTime()) return { uploaded: 0 };
    let uploaded = await this.uploadEligibleAuditScans(session);
    if (Date.now() < new Date(session.deadline).getTime()) {
      uploaded += await this.uploadEligibleAuditIncidents(session);
    }
    if (Date.now() < new Date(session.deadline).getTime()) {
      uploaded += await this.uploadEligibleAuditOverrides(session);
    }
    return { uploaded };
  }

  private async drainTransitionAuditQueues(): Promise<void> {
    const credentials = await ApiClient.getTransitionAuditCredentials();
    for (const credential of credentials) {
      if (Date.now() >= Date.parse(credential.expires_at)) {
        await DatabaseService.quarantineEventScanLogs(
          credential.event_id,
          'The authorized event-transition audit upload window expired'
        );
        await ApiClient.removeTransitionAuditCredential(credential.event_id);
        continue;
      }
      try {
        await this.drainDeregisteredAuditQueues({
          eventId: credential.event_id,
          cutoff: credential.cutoff,
          deadline: credential.expires_at,
          accessToken: credential.auditToken,
        });
      } catch (error) {
        if (
          error instanceof ApiError &&
          (error.code === 'DEVICE_BLACKLISTED' || error.code === 'DEVICE_DEREGISTERED')
        ) {
          await DatabaseService.quarantineEventScanLogs(
            credential.event_id,
            `Transition audit authority is unavailable: ${error.message}`
          );
          await ApiClient.removeTransitionAuditCredential(credential.event_id);
        }
      }
    }
  }

  private async uploadEligibleAuditScans(session: DeregisteredAuditSession): Promise<number> {
    const records = await DatabaseService.getEligibleAuditScanLogs(
      session.eventId,
      session.cutoff,
      SCAN_UPLOAD_BATCH_SIZE
    );
    if (records.length === 0) return 0;
    const groups = new Map<number, typeof records>();
    records.forEach((record) => {
      const group = groups.get(record.event_id) ?? [];
      group.push(record);
      groups.set(record.event_id, group);
    });
    const deviceId = await this.getDeviceId();
    let uploaded = 0;
    for (const [eventId, group] of groups) {
      if (Date.now() >= new Date(session.deadline).getTime()) break;
      const response = await ApiClient.auditRequest<QueueAckResponse>(
        session.accessToken,
        '/sync/scan-logs',
        {
          method: 'POST',
          body: {
            device_id: deviceId,
            event_id: eventId,
            logs: group.map((record) => ({
              client_record_id: record.device_scan_id,
              event_id: record.event_id,
              user_id: record.user_id,
              area_id: record.area_id,
              access_granted: record.access_granted,
              failure_reason: record.failure_reason,
              scanned_at: record.scanned_at,
              device_scan_id: record.device_scan_id,
              credential_id: record.credential_id,
              nonce_hash: record.nonce_hash,
              decision_code: record.decision_code,
              decision_source: record.decision_source,
              manual_reason: record.manual_reason,
              identity_evidence_confirmed: record.identity_evidence_confirmed,
              trust_generation: record.trust_generation,
              user_snapshot_at: record.user_snapshot_at,
              device_info: {
                scanner_installation_id: record.scanner_installation_id,
              },
            })),
          },
        }
      );
      const byId = new Map(response.results.map((result) => [result.client_record_id, result]));
      const outcomes = group.map((record) => {
        const result = record.device_scan_id ? byId.get(record.device_scan_id) : undefined;
        return {
          id: record.id,
          status: result?.status ?? 'retryable_error' as const,
          error: result?.error ?? (result ? undefined : 'Malformed acknowledgement'),
          serverId: result?.server_id,
        };
      });
      await DatabaseService.recordScanUploadOutcomes(outcomes);
      uploaded += outcomes.filter(
        (outcome) => outcome.status === 'accepted' || outcome.status === 'duplicate'
      ).length;
    }
    return uploaded;
  }

  private async uploadEligibleAuditIncidents(session: DeregisteredAuditSession): Promise<number> {
    const records = await DatabaseService.getEligibleAuditIncidents(
      session.eventId,
      session.cutoff,
      AUXILIARY_UPLOAD_BATCH_SIZE
    );
    let uploaded = 0;
    for (const record of records) {
      if (Date.now() >= new Date(session.deadline).getTime()) break;
      const response = await ApiClient.auditRequest<RecordAckResponse>(
        session.accessToken,
        '/incidents',
        {
          method: 'POST',
          body: {
            client_record_id: record.client_record_id,
            event_id: record.event_id,
            category: record.category,
            description: record.description,
            area_id: record.area_id ?? undefined,
            occurred_at: record.occurred_at,
          },
        }
      );
      if (this.isAcceptedAcknowledgement(response, record.client_record_id)) {
        await DatabaseService.markIncidentsSynced([record.id]);
        uploaded += 1;
      }
    }
    return uploaded;
  }

  private async uploadEligibleAuditOverrides(session: DeregisteredAuditSession): Promise<number> {
    const records = await DatabaseService.getEligibleAuditOverrides(
      session.eventId,
      session.cutoff,
      AUXILIARY_UPLOAD_BATCH_SIZE
    );
    let uploaded = 0;
    for (const record of records) {
      if (Date.now() >= new Date(session.deadline).getTime()) break;
      if (!record.area_id) continue;
      const user = record.user_email
        ? await DatabaseService.getUserByEmail(record.user_email, record.event_id)
        : undefined;
      const response = await ApiClient.auditRequest<RecordAckResponse>(
        session.accessToken,
        '/incidents/overrides',
        {
          method: 'POST',
          body: {
            client_record_id: record.client_record_id,
            event_id: record.event_id,
            area_id: record.area_id,
            access_granted: record.access_granted,
            reason: record.reason,
            user_id: user?.id,
            occurred_at: record.occurred_at,
          },
        }
      );
      if (this.isAcceptedAcknowledgement(response, record.client_record_id)) {
        await DatabaseService.markOverridesSynced([record.id]);
        uploaded += 1;
      }
    }
    return uploaded;
  }

  private async uploadQueuedScans(eventId: number): Promise<number> {
    let totalUploaded = 0;
    const deviceId = await this.getDeviceId();
    const maximumBatches = SCAN_UPLOAD_MAX_BATCHES_PER_SYNC ?? 1;

    for (let batchNumber = 0; batchNumber < maximumBatches; batchNumber += 1) {
      const pending = await DatabaseService.getUnsyncedScanLogs(SCAN_UPLOAD_BATCH_SIZE, eventId);
      if (pending.length === 0) break;

      let uploadedThisBatch = 0;
      let receivedRetryableFailure = false;
      for (const records of [pending]) {
        const logs = records.map((log) => ({
          client_record_id: log.device_scan_id,
          event_id: log.event_id,
          user_id: log.user_id,
          area_id: log.area_id,
          access_granted: log.access_granted,
          failure_reason: log.failure_reason,
          scanned_at: log.scanned_at,
          device_scan_id: log.device_scan_id,
          credential_id: log.credential_id,
          nonce_hash: log.nonce_hash,
          decision_code: log.decision_code,
          decision_source: log.decision_source,
          manual_reason: log.manual_reason,
          identity_evidence_confirmed: log.identity_evidence_confirmed,
          trust_generation: log.trust_generation,
          user_snapshot_at: log.user_snapshot_at,
          device_info: {
            scanner_installation_id: log.scanner_installation_id,
          },
        }));

        try {
          const response = await withBackoff(() =>
            ApiClient.request<QueueAckResponse>('/sync/scan-logs', {
              method: 'POST',
              timeoutMs: 20_000,
              idempotencyKey: `scan:${eventId}:${records.map((record) => record.device_scan_id).join(',')}`,
              body: { logs, device_id: deviceId, event_id: eventId },
            })
          );
          const byId = new Map(response.results.map((result) => [result.client_record_id, result]));
          const outcomes = records.map((record) => {
            const result = record.device_scan_id ? byId.get(record.device_scan_id) : undefined;
            return {
              id: record.id,
              status: result?.status ?? 'retryable_error' as const,
              error: result?.error ?? (result ? undefined : 'Malformed acknowledgement'),
              serverId: result?.server_id,
            };
          });
          receivedRetryableFailure ||= outcomes.some((outcome) => outcome.status === 'retryable_error');
          await DatabaseService.recordScanUploadOutcomes(outcomes);
          uploadedThisBatch += outcomes.filter(
            (outcome) => outcome.status === 'accepted' || outcome.status === 'duplicate'
          ).length;
        } catch (error) {
          await DatabaseService.recordScanUploadOutcomes(records.map((record) => ({
            id: record.id,
            status: 'retryable_error' as const,
            error: this.queueError(error),
          })));
          receivedRetryableFailure = true;
        }
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
