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
import crypto from 'node:crypto';
import { ApiClient } from '../src/services/ApiClient';
import { QrCredentialService, QrTrustMaterial } from '../src/services/QrCredentialService';
import { evaluateManualAssignment } from '../src/services/RecordingAuthorityService';
import type { User } from '../src/services/DatabaseService';

const live = process.env.COMPAT_LIVE === '1' ? it : it.skip;

describe('Scan production-shared compatibility flow', () => {
  live('synchronizes, decides offline, uploads, and performs typed fallback', async () => {
    const passInput = process.env.COMPAT_PASS_OUTPUT;
    const output = process.env.COMPAT_SCAN_OUTPUT;
    const eventId = Number(process.env.COMPAT_EVENT_ID);
    const authorizedAreaId = Number(process.env.COMPAT_AUTHORIZED_AREA_ID);
    const deniedAreaId = Number(process.env.COMPAT_DENIED_AREA_ID);
    if (!passInput || !output || !Number.isSafeInteger(eventId)) {
      throw new Error('Scan compatibility environment is incomplete');
    }
    const pass = JSON.parse(await fs.readFile(passInput, 'utf8'));
    await ApiClient.clearTokens();
    await ApiClient.login('scanner@test.com', 'password123');
    const installationId = `scan-${crypto.randomUUID()}`;
    const registration = await ApiClient.registerDeviceSession(eventId, installationId, 'android');
    const users = await ApiClient.request<{ users: User[]; metadata: { timestamp: string } }>(
      '/sync/users-database', { params: { event_id: eventId } }
    );
    const areas = await ApiClient.request<{ areas: Array<{ id: number; name: string }> }>(
      '/sync/areas-database', { params: { event_id: eventId, view: 'full' } }
    );
    const trustPage = await ApiClient.request<any>('/sync/qr-trust', {
      params: { event_id: eventId, limit: 200 },
    });
    const trust: QrTrustMaterial = {
      generation: trustPage.snapshot_generation,
      generated_at: trustPage.generated_at,
      hard_expires_at: trustPage.hard_expires_at,
      authority_keys: trustPage.authority_keys,
      revocations: trustPage.revocations,
    };
    const verification = await QrCredentialService.verifyWithTrust(pass.presentation, eventId, trust);
    expect(verification.valid).toBe(true);
    const subject = users.users.find((user) => user.id === pass.user_id);
    if (!subject || !verification.presentation) throw new Error('Synchronized attendee is unavailable');
    const grant = evaluateManualAssignment(subject, eventId, authorizedAreaId);
    const denial = evaluateManualAssignment(subject, eventId, deniedAreaId);
    expect(grant).toMatchObject({ granted: true });
    expect(denial).toMatchObject({ granted: false, code: 'manual_assignment_missing' });
    expect(areas.areas.map((area) => area.id)).toEqual(expect.arrayContaining([
      authorizedAreaId, deniedAreaId,
    ]));

    const grantRecordId = crypto.randomUUID();
    const denialRecordId = crypto.randomUUID();
    const common = {
      event_id: eventId,
      user_id: subject.id,
      scanned_at: new Date().toISOString(),
      credential_id: verification.presentation.credential_id,
      nonce_hash: verification.presentation.nonce_hash,
      decision_source: 'offline-current',
      trust_generation: trust.generation,
      user_snapshot_at: users.metadata.timestamp,
      device_info: { source: 'compatibility-native-adapter' },
    };
    const upload = await ApiClient.request<any>('/sync/scan-logs', {
      method: 'POST',
      idempotencyKey: `compat-${grantRecordId}`,
      body: {
        event_id: eventId,
        device_id: installationId,
        logs: [
          { ...common, client_record_id: grantRecordId, area_id: authorizedAreaId, access_granted: true, failure_reason: null, decision_code: 'access_granted' },
          { ...common, client_record_id: denialRecordId, area_id: deniedAreaId, access_granted: false, failure_reason: 'No current assignment authorizes this area.', decision_code: 'assignment_missing' },
        ],
      },
    });
    const inconclusive = await QrCredentialService.verify(pass.presentation, eventId, '');
    expect(inconclusive).toMatchObject({ valid: false, conclusive: false, code: 'trust_snapshot_required' });
    const fallbackRecordId = crypto.randomUUID();
    const fallback = await ApiClient.request<any>('/scan/verify', {
      method: 'POST',
      idempotencyKey: `compat-${fallbackRecordId}`,
      body: {
        qr_code: pass.presentation,
        area_id: authorizedAreaId,
        event_id: eventId,
        device_scan_id: fallbackRecordId,
        local_evidence: {
          trust_generation: trust.generation,
          user_snapshot_at: users.metadata.timestamp,
          trust_freshness: verification.trust_freshness,
        },
      },
    });
    expect(fallback).toMatchObject({ access_granted: true });

    await fs.writeFile(output, JSON.stringify({
      event_id: eventId,
      scanner_registration_id: registration.id,
      synchronized_user_count: users.users.length,
      synchronized_area_count: areas.areas.length,
      trust_generation: trust.generation,
      verification: {
        valid: verification.valid,
        code: verification.code,
        conclusive: verification.conclusive,
        trust_freshness: verification.trust_freshness,
        user_id: verification.presentation.user_id,
        credential_id: verification.presentation.credential_id,
        nonce_hash: verification.presentation.nonce_hash,
      },
      grant,
      denial,
      upload_acknowledgements: upload.results ?? upload,
      grant_record_id: grantRecordId,
      denial_record_id: denialRecordId,
      inconclusive: { code: inconclusive.code, conclusive: inconclusive.conclusive },
      fallback: {
        access_granted: fallback.access_granted,
        decision_code: fallback.decision_code,
        record_id: fallbackRecordId,
      },
      trace: ApiClient.getLastRequestTrace(),
    }) + '\n');
  }, 90_000);
});
