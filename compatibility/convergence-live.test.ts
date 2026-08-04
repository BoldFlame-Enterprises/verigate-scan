/* eslint-disable import/first */
const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(async (key: string, value: string) => { mockStore.set(key, value); }),
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  deleteItemAsync: jest.fn(async (key: string) => { mockStore.delete(key); }),
}));
jest.mock('expo-crypto', () => {
  const crypto = require('node:crypto');
  return {
    randomUUID: () => crypto.randomUUID(),
    digestStringAsync: async (_algorithm: string, value: string) =>
      crypto.createHash('sha256').update(value).digest('hex'),
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    CryptoEncoding: { HEX: 'hex' },
  };
});
jest.mock('../src/config', () => ({ API_BASE_URL: process.env.COMPAT_BACKEND_URL }));

import fs from 'node:fs/promises';
import http from 'node:http';
import crypto from 'node:crypto';
import { ApiClient, ApiError } from '../src/services/ApiClient';
import { OfflineSessionService } from '../src/services/OfflineSessionService';
import { QrCredentialService, QrTrustMaterial } from '../src/services/QrCredentialService';
import { evaluateManualAssignment } from '../src/services/RecordingAuthorityService';
import type { User } from '../src/services/DatabaseService';

const live = process.env.COMPAT_LIVE === '1' ? it : it.skip;

function safeInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Invalid ${label}`);
  return parsed;
}

async function discardResponseAfterPersistence(
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<{ upstream_status: number; caller_received_body: false }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const request = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers,
    }, (response) => {
      const status = response.statusCode ?? 0;
      // Response headers are emitted only after the route has persisted its
      // transaction. Drop the body to model an ambiguous transport result.
      response.destroy();
      resolve({ upstream_status: status, caller_received_body: false });
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

describe('Scan production-shared convergence compatibility flow', () => {
  live('captures lost-response, offline case, and event-isolation evidence', async () => {
    if (process.env.COMPAT_CONVERGENCE_MODE === 'revoked') return;
    const inputPath = process.env.COMPAT_CONVERGENCE_INPUT;
    const outputPath = process.env.COMPAT_CONVERGENCE_OUTPUT;
    if (!inputPath || !outputPath) throw new Error('Convergence paths are required');
    const input = JSON.parse(await fs.readFile(inputPath, 'utf8'));
    const eventId = safeInteger(input.fixture.event_id, 'event ID');
    const otherEventId = safeInteger(input.fixture.other_event_id, 'other event ID');
    const attendeeId = safeInteger(input.fixture.attendee_user_id, 'attendee ID');
    const authorizedAreaId = safeInteger(input.fixture.authorized_area_id, 'area ID');
    const otherAreaId = safeInteger(input.fixture.other_area_id, 'other area ID');
    const occurredAt = new Date().toISOString();

    await ApiClient.clearTokens();
    await ApiClient.login('scanner@test.com', 'password123');
    const installationId = `scan-convergence-${crypto.randomUUID()}`;
    await ApiClient.registerDeviceSession(eventId, installationId, 'android');
    const users = await ApiClient.request<{ users: User[]; metadata: { timestamp: string } }>(
      '/sync/users-database', { params: { event_id: eventId } }
    );
    const subject = users.users.find((user) => user.id === attendeeId);
    if (!subject) throw new Error('Synchronized attendee is unavailable');
    const beforeRevocation = evaluateManualAssignment(subject, eventId, authorizedAreaId);
    expect(beforeRevocation.granted).toBe(true);

    const stableScanId = crypto.randomUUID();
    const scanBody = {
      event_id: eventId,
      device_id: installationId,
      logs: [{
        event_id: eventId,
        client_record_id: stableScanId,
        user_id: attendeeId,
        area_id: authorizedAreaId,
        access_granted: true,
        failure_reason: null,
        scanned_at: occurredAt,
        decision_code: 'access_granted',
        decision_source: 'offline-current',
        user_snapshot_at: users.metadata.timestamp,
        device_info: { source: 'compatibility-lost-response-adapter' },
      }],
    };
    const accessToken = mockStore.get('verigate_scan_access_token');
    if (!accessToken) throw new Error('Device access material is unavailable');
    const lost = await discardResponseAfterPersistence(
      `${process.env.COMPAT_BACKEND_URL}/sync/scan-logs`,
      {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(JSON.stringify(scanBody))),
        'X-Correlation-Id': `lost.${stableScanId}`,
      },
      scanBody
    );
    expect(lost).toEqual({ upstream_status: 200, caller_received_body: false });
    const retry = await ApiClient.request<any>('/sync/scan-logs', {
      method: 'POST',
      idempotencyKey: `retry-${stableScanId}`,
      body: scanBody,
    });
    expect(retry.results).toEqual([
      expect.objectContaining({ client_record_id: stableScanId, status: 'duplicate' }),
    ]);

    let offlineProven = false;
    try {
      await fetch('http://127.0.0.1:1/unavailable', { signal: AbortSignal.timeout(500) });
    } catch {
      offlineProven = true;
    }
    expect(offlineProven).toBe(true);
    const sharedCaseId = `case-${crypto.randomUUID()}`;
    const incident = await ApiClient.request<any>('/incidents', {
      method: 'POST',
      idempotencyKey: sharedCaseId,
      body: {
        event_id: eventId,
        area_id: authorizedAreaId,
        category: 'technical',
        description: `Compatibility offline incident ${input.run_id}`,
        client_record_id: sharedCaseId,
        occurred_at: occurredAt,
      },
    });
    const overrideId = `override-${crypto.randomUUID()}`;
    const override = await ApiClient.request<any>('/incidents/overrides', {
      method: 'POST',
      idempotencyKey: overrideId,
      body: {
        event_id: eventId,
        area_id: authorizedAreaId,
        user_id: attendeeId,
        access_granted: true,
        reason: `Compatibility identity evidence ${input.run_id}`,
        client_record_id: overrideId,
        occurred_at: occurredAt,
      },
    });

    await ApiClient.clearTokens();
    await ApiClient.login('scanner@test.com', 'password123');
    const otherInstallation = `scan-other-${crypto.randomUUID()}`;
    await ApiClient.registerDeviceSession(otherEventId, otherInstallation, 'android');
    const otherIncident = await ApiClient.request<any>('/incidents', {
      method: 'POST',
      idempotencyKey: sharedCaseId,
      body: {
        event_id: otherEventId,
        area_id: otherAreaId,
        category: 'technical',
        description: `Compatibility isolated incident ${input.run_id}`,
        client_record_id: sharedCaseId,
        occurred_at: occurredAt,
      },
    });
    let crossEventStatus = 0;
    try {
      await ApiClient.request('/sync/users-database', { params: { event_id: eventId } });
    } catch (error) {
      crossEventStatus = error instanceof ApiError ? error.statusCode : -1;
    }
    expect([403, 409]).toContain(crossEventStatus);

    await fs.writeFile(outputPath, JSON.stringify({
      stable_scan_id: stableScanId,
      lost_response: lost,
      retry_status: retry.results[0].status,
      before_revocation: beforeRevocation,
      offline_proven: offlineProven,
      occurred_at: occurredAt,
      incident: { id: incident.record.id, client_record_id: sharedCaseId, status: incident.status },
      override: { id: override.record.id, client_record_id: overrideId, status: override.status },
      other_incident: { id: otherIncident.record.id, client_record_id: sharedCaseId, status: otherIncident.status },
      cross_event_status: crossEventStatus,
      trace: ApiClient.getLastRequestTrace(),
    }, null, 2) + '\n');
  }, 90_000);

  live('synchronizes the revoked assignment and denies its former area', async () => {
    if (process.env.COMPAT_CONVERGENCE_MODE !== 'revoked') return;
    const inputPath = process.env.COMPAT_CONVERGENCE_INPUT;
    const outputPath = process.env.COMPAT_CONVERGENCE_OUTPUT;
    if (!inputPath || !outputPath) throw new Error('Convergence paths are required');
    const input = JSON.parse(await fs.readFile(inputPath, 'utf8'));
    const eventId = safeInteger(input.fixture.event_id, 'event ID');
    const attendeeId = safeInteger(input.fixture.attendee_user_id, 'attendee ID');
    const areaId = safeInteger(input.fixture.authorized_area_id, 'area ID');
    await ApiClient.clearTokens();
    await ApiClient.login('scanner@test.com', 'password123');
    await ApiClient.registerDeviceSession(eventId, `scan-revoked-${crypto.randomUUID()}`, 'android');
    const users = await ApiClient.request<{ users: User[] }>('/sync/users-database', {
      params: { event_id: eventId },
    });
    const subject = users.users.find((user) => user.id === attendeeId);
    if (!subject) throw new Error('Revoked attendee is unavailable');
    const decision = evaluateManualAssignment(subject, eventId, areaId);
    expect(decision).toMatchObject({ granted: false, code: 'manual_assignment_missing' });

    const trustPage = await ApiClient.request<any>('/sync/qr-trust', {
      params: { event_id: eventId, limit: 200 },
    });
    const presentationIssuedAt = Number(
      (JSON.parse(input.pass.presentation) as { iat: number }).iat
    ) * 1000;
    const hardExpiry = presentationIssuedAt + 30_000;
    const trust: QrTrustMaterial = {
      generation: trustPage.snapshot_generation,
      generated_at: new Date(presentationIssuedAt).toISOString(),
      hard_expires_at: new Date(hardExpiry).toISOString(),
      authority_keys: trustPage.authority_keys,
      revocations: trustPage.revocations,
    };
    const trustBefore = await QrCredentialService.verifyWithTrust(
      input.pass.presentation, eventId, trust, hardExpiry - 1
    );
    const trustAt = await QrCredentialService.verifyWithTrust(
      input.pass.presentation, eventId, trust, hardExpiry
    );
    const trustAfter = await QrCredentialService.verifyWithTrust(
      input.pass.presentation, eventId, trust, hardExpiry + 1
    );
    expect(trustBefore.valid).toBe(true);
    expect(trustAt.valid).toBe(true);
    expect(trustAfter).toMatchObject({ valid: false, code: 'trust_snapshot_expired' });

    const sessionStart = Date.now();
    const dateNow = jest.spyOn(Date, 'now').mockReturnValue(sessionStart);
    const bindings = { deviceId: `scan-revoked-${eventId}`, tokenBinding: ApiClient.getTokenBinding() };
    await OfflineSessionService.create(attendeeId, 'vip@test.com', eventId, 'production', bindings);
    const rawSession = mockStore.get('verigate_scan_offline_session_v2');
    if (!rawSession) throw new Error('Scan offline session fixture is unavailable');
    const session = JSON.parse(rawSession);
    dateNow.mockReturnValue(session.expiresAt - 1);
    const sessionBefore = await OfflineSessionService.getValid({
      userId: attendeeId, email: 'vip@test.com', eventId, ...bindings,
    });
    mockStore.set('verigate_scan_offline_session_v2', rawSession);
    dateNow.mockReturnValue(session.expiresAt);
    const sessionAt = await OfflineSessionService.getValid({
      userId: attendeeId, email: 'vip@test.com', eventId, ...bindings,
    });
    mockStore.set('verigate_scan_offline_session_v2', rawSession);
    dateNow.mockReturnValue(session.expiresAt + 1);
    const sessionAfter = await OfflineSessionService.getValid({
      userId: attendeeId, email: 'vip@test.com', eventId, ...bindings,
    });
    dateNow.mockRestore();
    expect(sessionBefore).not.toBeNull();
    expect(sessionAt).toBeNull();
    expect(sessionAfter).toBeNull();

    const recovery = await ApiClient.request<any>('/sync/scan-logs', {
      method: 'POST',
      idempotencyKey: input.recovery_record_id,
      body: {
        event_id: eventId,
        device_id: `scan-revoked-${eventId}`,
        logs: [{
          event_id: eventId,
          client_record_id: input.recovery_record_id,
          user_id: attendeeId,
          area_id: areaId,
          access_granted: false,
          failure_reason: 'Assignment was revoked before network recovery.',
          scanned_at: input.recovery_occurred_at,
          decision_code: 'assignment_missing',
          decision_source: 'offline-current',
        }],
      },
    });
    expect(recovery.results[0].status).toBe('accepted');
    await fs.writeFile(outputPath, JSON.stringify({
      assignment_count: subject.assignments?.length ?? 0,
      decision,
      recovery_status: recovery.results[0].status,
      trust_hard_expiry_boundary: {
        before: trustBefore.valid,
        at: trustAt.valid,
        after: trustAfter.valid,
      },
      offline_session_boundary: {
        before: sessionBefore !== null,
        at: sessionAt !== null,
        after: sessionAfter !== null,
      },
      trace: ApiClient.getLastRequestTrace(),
    }, null, 2) + '\n');
  }, 60_000);
});
