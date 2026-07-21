/* eslint-disable import/first */
import { p256 } from '@noble/curves/p256';

jest.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  CryptoEncoding: { HEX: 'hex' },
  digestStringAsync: jest.fn(async (_algorithm: string, value: string) => jest.requireActual('crypto').createHash('sha256').update(value).digest('hex')),
}));

import { QrCredentialService, QR_PROTOCOL_VERSION } from '../QrCredentialService';

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
});
