/* eslint-disable import/first */
import { p256 } from '@noble/curves/p256';

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  CryptoEncoding: { HEX: 'hex' },
  digestStringAsync: jest.fn(async (_algorithm: string, value: string) => jest.requireActual('crypto').createHash('sha256').update(value).digest('hex')),
}));

import {
  QrCredentialService,
  QR_PROTOCOL_VERSION,
  QrTrustMaterial,
} from '../QrCredentialService';
import qrV3Fixture from '../__fixtures__/qr-v3-contract.json';

const SPKI_PREFIX = '3059301306072a8648ce3d020106082a8648ce3d030107034200';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function spki(privateKey: Uint8Array): string {
  return Buffer.from(SPKI_PREFIX + Buffer.from(p256.getPublicKey(privateKey, false)).toString('hex'), 'hex').toString('base64');
}

function digest(value: unknown): Uint8Array {
  return jest.requireActual('crypto').createHash('sha256').update(canonical(value)).digest();
}

function fixture(eventId = 9): { encoded: string; authorityPublicKey: string } {
  const authorityKey = Uint8Array.from([...new Array(31).fill(0), 1]);
  const deviceKey = Uint8Array.from([...new Array(31).fill(0), 2]);
  const authorityPublicKey = spki(authorityKey);
  const credentialPayload = {
    version: QR_PROTOCOL_VERSION,
    credential_id: 'credential-1',
    credential_version: 'version-1',
    user_id: 7,
    email: 'vip@example.com',
    name: 'VIP Guest',
    event_id: eventId,
    device_id: 'device-1',
    device_public_key: spki(deviceKey),
    assignments: [{ area_id: 3, area_name: 'Arena', access_level_id: 2, access_level_name: 'VIP', access_priority: 5, valid_from: '1970-01-01T00:00:00.000Z', valid_until: '2100-01-01T00:00:00.000Z' }],
    issued_at: 1_000,
    expires_at: 100_000,
  };
  const credential = {
    payload: credentialPayload,
    authority_signature: bytesToBase64(p256.sign(digest(credentialPayload), authorityKey).toDERRawBytes()),
    authority_public_key: authorityPublicKey,
  };
  const payload = { version: QR_PROTOCOL_VERSION, credential, issued_at: 10_000, expires_at: 70_000, nonce: 'nonce-1' };
  return {
    authorityPublicKey,
    encoded: JSON.stringify({ payload, device_signature: bytesToBase64(p256.sign(digest(payload), deviceKey).toDERRawBytes()) }),
  };
}

function v3Fixture(): { encoded: string; trust: QrTrustMaterial; now: number } {
  const now = qrV3Fixture.verification.now * 1_000;
  return {
    encoded: canonical({
      ...qrV3Fixture.valid.presentation_unsigned,
      s: qrV3Fixture.valid.device_signature,
    }),
    now,
    trust: {
      generation: 1,
      generated_at: new Date(now).toISOString(),
      hard_expires_at: new Date(now + 24 * 60 * 60 * 1_000).toISOString(),
      authority_keys: [{
        kid: 'qr-2026-01',
        public_key: qrV3Fixture.verification.authority_public_key,
        status: 'active',
        verify_until: null,
      }],
      revocations: [],
      legacy_authority_public_key: null,
    },
  };
}

describe('QrCredentialService', () => {
  it('accepts a valid authority- and device-signed event presentation', async () => {
    const value = fixture();
    const result = await QrCredentialService.verify(value.encoded, 9, value.authorityPublicKey, 20_000);
    expect(result.valid).toBe(true);
    expect(result.presentation?.assignments[0].area_id).toBe(3);
  });

  it('rejects a valid signature presented for another event', async () => {
    const value = fixture();
    const result = await QrCredentialService.verify(value.encoded, 10, value.authorityPublicKey, 20_000);
    expect(result).toMatchObject({ valid: false, reason: 'QR belongs to a different event' });
  });

  it('shares the fixed compact v3 golden vector while keeping parser versions separate', async () => {
    const encoded = canonical({
      ...qrV3Fixture.valid.presentation_unsigned,
      s: qrV3Fixture.valid.device_signature,
    });
    expect(p256.verify(
      Buffer.from(qrV3Fixture.valid.authority_signature, 'base64url'),
      digest(qrV3Fixture.valid.credential_payload),
      Buffer.from(qrV3Fixture.verification.authority_public_key, 'base64url')
    )).toBe(true);
    expect(p256.verify(
      Buffer.from(qrV3Fixture.valid.device_signature, 'base64url'),
      digest(qrV3Fixture.valid.presentation_unsigned),
      Buffer.from(qrV3Fixture.verification.device_public_key, 'base64url')
    )).toBe(true);
    expect(Buffer.byteLength(encoded)).toBe(qrV3Fixture.valid.encoded_utf8_bytes);
    expect(qrV3Fixture.mutations).toHaveLength(23);
    await expect(QrCredentialService.verify(
      encoded,
      qrV3Fixture.verification.expected_event_id,
      qrV3Fixture.verification.authority_public_key,
      qrV3Fixture.verification.now * 1_000
    )).resolves.toMatchObject({
      valid: false,
      code: 'trust_snapshot_required',
      conclusive: false,
    });
  });

  it('verifies the compact v3 fixture using synchronized trust material', async () => {
    const value = v3Fixture();

    await expect(QrCredentialService.verifyWithTrust(
      value.encoded,
      qrV3Fixture.verification.expected_event_id,
      value.trust,
      value.now
    )).resolves.toMatchObject({
      valid: true,
      code: 'valid',
      conclusive: true,
      trust_freshness: 'current',
      presentation: {
        user_id: 7,
        event_id: 4,
        credential_id: '00112233-4455-6677-8899-aabbccddeeff',
        device_id: 'pass-550e8400-e29b-41d4-a716-446655440000',
        credential_generation: 12,
        registration_generation: 3,
        protocol: 3,
        nonce_hash: 'be45cb2605bf36bebde684841a28f0fd43c69850a3dce5fedba69928ee3a8991',
      },
    });
  });

  it('distinguishes credential and registration-generation revocations', async () => {
    const value = v3Fixture();
    const credentialRevoked: QrTrustMaterial = {
      ...value.trust,
      revocations: [{
        generation: 2,
        credential_id: '00112233-4455-6677-8899-aabbccddeeff',
        device_id: 'pass-550e8400-e29b-41d4-a716-446655440000',
        registration_generation: 3,
      }],
    };
    await expect(QrCredentialService.verifyWithTrust(
      value.encoded, 4, credentialRevoked, value.now
    )).resolves.toMatchObject({ valid: false, code: 'credential_revoked', conclusive: true });

    const deviceRevoked: QrTrustMaterial = {
      ...value.trust,
      revocations: [{
        generation: 3,
        credential_id: null,
        device_id: 'pass-550e8400-e29b-41d4-a716-446655440000',
        registration_generation: 3,
      }],
    };
    await expect(QrCredentialService.verifyWithTrust(
      value.encoded, 4, deviceRevoked, value.now
    )).resolves.toMatchObject({ valid: false, code: 'device_revoked', conclusive: true });
  });

  it('treats an expired trust snapshot as inconclusive', async () => {
    const value = v3Fixture();
    const expired = {
      ...value.trust,
      hard_expires_at: new Date(value.now - 1).toISOString(),
    };

    await expect(QrCredentialService.verifyWithTrust(
      value.encoded, 4, expired, value.now
    )).resolves.toMatchObject({
      valid: false,
      code: 'trust_snapshot_expired',
      conclusive: false,
      trust_freshness: 'expired',
    });
  });
});
