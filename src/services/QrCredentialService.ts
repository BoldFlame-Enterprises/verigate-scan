import * as Crypto from 'expo-crypto';
import { p256 } from '@noble/curves/p256';
import { sha256 } from '@noble/hashes/sha256';

export const QR_PROTOCOL_VERSION = 'verigate-qr-v2';
export const QR_PROTOCOL_V3 = 3;
export const QR_TRUST_SOFT_AGE_MS = 60_000;
export const QR_TRUST_HARD_AGE_MS = 24 * 60 * 60 * 1000;

export interface CredentialAssignment {
  area_id: number;
  area_name: string;
  access_level_id: number;
  access_level_name: string;
  access_priority: number;
  valid_from: string;
  valid_until: string;
}

export interface VerifiedPresentation {
  user_id: number;
  email: string;
  name: string;
  event_id: number;
  credential_id: string;
  nonce: string;
  assignments: CredentialAssignment[];
  protocol?: 2 | 3;
  device_id?: string;
  credential_generation?: number;
  registration_generation?: number;
  nonce_hash?: string;
}

export interface QrTrustMaterial {
  generation: number;
  generated_at: string;
  hard_expires_at: string;
  authority_keys: {
    kid: string;
    public_key: string;
    status: 'active' | 'retiring';
    verify_until: number | null;
  }[];
  revocations: {
    generation: number;
    credential_id: string | null;
    device_id: string;
    registration_generation: number | null;
  }[];
  legacy_authority_public_key?: string | null;
}

export interface QrVerificationDecision {
  valid: boolean;
  code: string;
  conclusive: boolean;
  reason?: string;
  presentation?: VerifiedPresentation;
  trust_freshness?: 'current' | 'stale' | 'expired';
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

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  return base64ToBytes(padded);
}

function exactObject(value: unknown, keys: string[]): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value as Record<string, unknown>).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function boundedBase64Url(value: unknown, bytes: number): value is string {
  if (typeof value !== 'string' || value.includes('=') || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return false;
  }
  try {
    const decoded = base64UrlToBytes(value);
    return decoded.length === bytes;
  } catch {
    return false;
  }
}

function credentialUuid(value: string): string {
  const hex = Array.from(base64UrlToBytes(value))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function nonceHash(value: string): Promise<string> {
  return Array.from(sha256(base64UrlToBytes(value)))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function freshness(trust: QrTrustMaterial, now: number): 'current' | 'stale' | 'expired' {
  const generated = new Date(trust.generated_at).getTime();
  const hardExpiry = new Date(trust.hard_expires_at).getTime();
  if (!Number.isFinite(generated) || !Number.isFinite(hardExpiry) || now > hardExpiry ||
      now - generated > QR_TRUST_HARD_AGE_MS) return 'expired';
  return now - generated <= QR_TRUST_SOFT_AGE_MS ? 'current' : 'stale';
}

function hexToBytes(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/g)?.map((byte) => parseInt(byte, 16)) ?? []);
}

async function digest(value: unknown): Promise<Uint8Array> {
  const hex = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    canonical(value),
    { encoding: Crypto.CryptoEncoding.HEX }
  );
  return hexToBytes(hex);
}

class QrCredentialServiceClass {
  async verify(
    encoded: string,
    expectedEventId: number,
    trustedAuthorityPublicKey: string,
    now = Date.now()
  ): Promise<QrVerificationDecision> {
    let value: any;
    try {
      value = JSON.parse(encoded);
    } catch {
      return { valid: false, code: 'malformed_schema', conclusive: true, reason: 'Invalid QR format' };
    }

    if (value?.v === QR_PROTOCOL_V3) {
      return {
        valid: false,
        code: 'trust_snapshot_required',
        conclusive: false,
        reason: 'QR v3 requires synchronized trust state',
      };
    }

    const payload = value?.payload;
    const credential = payload?.credential;
    if (
      payload?.version !== QR_PROTOCOL_VERSION ||
      credential?.payload?.version !== QR_PROTOCOL_VERSION ||
      !value.device_signature
    ) {
      return { valid: false, code: 'unsupported_protocol', conclusive: true, reason: 'Unsupported QR credential' };
    }
    if (credential.authority_public_key !== trustedAuthorityPublicKey) {
      return { valid: false, code: 'unknown_authority_key', conclusive: true, reason: 'Untrusted QR authority' };
    }
    if (credential.payload.event_id !== expectedEventId) {
      return { valid: false, code: 'wrong_event', conclusive: true, reason: 'QR belongs to a different event' };
    }
    if (
      credential.payload.expires_at < now - 60_000 ||
      payload.expires_at < now - 60_000 ||
      payload.issued_at > now + 60_000 ||
      payload.expires_at - payload.issued_at > 60_000
    ) {
      return { valid: false, code: 'expired_or_future', conclusive: true, reason: 'QR credential expired or not yet valid' };
    }

    try {
      const authoritySpki = base64ToBytes(trustedAuthorityPublicKey);
      const authorityRaw = authoritySpki.slice(authoritySpki.length - 65);
      if (!p256.verify(
        base64ToBytes(credential.authority_signature),
        await digest(credential.payload),
        authorityRaw
      )) {
        return { valid: false, code: 'invalid_authority_signature', conclusive: true, reason: 'Authority signature invalid' };
      }

      const deviceSpki = base64ToBytes(credential.payload.device_public_key);
      const deviceRaw = deviceSpki.slice(deviceSpki.length - 65);
      if (!p256.verify(base64ToBytes(value.device_signature), await digest(payload), deviceRaw)) {
        return { valid: false, code: 'invalid_device_signature', conclusive: true, reason: 'Device signature invalid' };
      }
    } catch {
      return { valid: false, code: 'invalid_key_or_signature', conclusive: true, reason: 'Invalid signing key or signature' };
    }

    return {
      valid: true,
      code: 'valid',
      conclusive: true,
      presentation: {
        user_id: credential.payload.user_id,
        email: credential.payload.email,
        name: credential.payload.name,
        event_id: credential.payload.event_id,
        credential_id: credential.payload.credential_id,
        nonce: payload.nonce,
        assignments: credential.payload.assignments,
        protocol: 2,
        device_id: credential.payload.device_id,
      },
    };
  }

  async verifyWithTrust(
    encoded: string,
    expectedEventId: number,
    trust: QrTrustMaterial,
    now = Date.now()
  ): Promise<QrVerificationDecision> {
    let raw: unknown;
    try {
      raw = JSON.parse(encoded);
    } catch {
      return { valid: false, code: 'malformed_schema', conclusive: true, reason: 'Invalid QR format' };
    }
    const trustFreshness = freshness(trust, now);
    if ((raw as { v?: unknown })?.v !== QR_PROTOCOL_V3) {
      const legacy = await this.verify(
        encoded,
        expectedEventId,
        trust.legacy_authority_public_key ?? '',
        now
      );
      if (legacy.valid && trustFreshness === 'expired') {
        return {
          valid: false,
          code: 'trust_snapshot_expired',
          conclusive: false,
          reason: 'QR trust snapshot has expired; synchronization required',
          trust_freshness: trustFreshness,
        };
      }
      if (
        legacy.valid &&
        legacy.presentation &&
        trust.revocations.some((entry) => entry.device_id === legacy.presentation!.device_id)
      ) {
        return {
          valid: false,
          code: 'device_revoked',
          conclusive: true,
          reason: 'Pass installation is revoked',
          trust_freshness: trustFreshness,
        };
      }
      return {
        ...legacy,
        conclusive: legacy.valid ? trustFreshness === 'current' : legacy.conclusive,
        trust_freshness: trustFreshness,
      };
    }
    if (new TextEncoder().encode(encoded).length > 800) {
      return { valid: false, code: 'payload_too_large', conclusive: true, reason: 'QR presentation exceeds 800 bytes' };
    }
    if (!exactObject(raw, ['v', 'c', 'iat', 'exp', 'n', 's'])) {
      return { valid: false, code: 'malformed_schema', conclusive: true, reason: 'QR presentation fields are invalid' };
    }
    const envelope = raw.c;
    if (!exactObject(envelope, ['p', 's'])) {
      return { valid: false, code: 'malformed_schema', conclusive: true, reason: 'QR credential envelope is invalid' };
    }
    const payload = envelope.p;
    if (!exactObject(payload, ['v', 'kid', 'cid', 'cg', 'uid', 'eid', 'did', 'rg', 'dpk', 'iat', 'exp'])) {
      return { valid: false, code: 'malformed_schema', conclusive: true, reason: 'QR credential fields are invalid' };
    }
    const presentation = raw as Record<string, any>;
    if (
      payload.v !== 3 ||
      typeof payload.kid !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(payload.kid) ||
      !boundedBase64Url(payload.cid, 16) ||
      !Number.isSafeInteger(payload.cg) || Number(payload.cg) <= 0 ||
      !Number.isSafeInteger(payload.uid) || Number(payload.uid) <= 0 ||
      !Number.isSafeInteger(payload.eid) || Number(payload.eid) <= 0 ||
      typeof payload.did !== 'string' ||
      !/^pass-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.did) ||
      !Number.isSafeInteger(payload.rg) || Number(payload.rg) <= 0 ||
      !boundedBase64Url(payload.dpk, 65) ||
      !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) ||
      !Number.isSafeInteger(presentation.iat) || !Number.isSafeInteger(presentation.exp) ||
      !boundedBase64Url(presentation.n, 16) ||
      !boundedBase64Url(envelope.s, 64) ||
      !boundedBase64Url(presentation.s, 64)
    ) {
      return { valid: false, code: 'malformed_schema', conclusive: true, reason: 'QR presentation values are invalid' };
    }
    const verifiedPayload = payload as unknown as {
      v: 3; kid: string; cid: string; cg: number; uid: number; eid: number;
      did: string; rg: number; dpk: string; iat: number; exp: number;
    };
    if (verifiedPayload.eid !== expectedEventId) {
      return { valid: false, code: 'wrong_event', conclusive: true, reason: 'QR belongs to a different event' };
    }
    const nowSeconds = Math.floor(now / 1000);
    if (
      verifiedPayload.exp < verifiedPayload.iat ||
      presentation.exp < presentation.iat ||
      presentation.exp - presentation.iat > 60 ||
      presentation.exp > verifiedPayload.exp
    ) {
      return { valid: false, code: 'invalid_interval', conclusive: true, reason: 'QR time interval is invalid' };
    }
    if (verifiedPayload.iat > nowSeconds + 60) {
      return { valid: false, code: 'credential_not_yet_valid', conclusive: true, reason: 'Credential is not yet valid' };
    }
    if (verifiedPayload.exp < nowSeconds - 60) {
      return { valid: false, code: 'credential_expired', conclusive: true, reason: 'Credential has expired' };
    }
    if (presentation.iat > nowSeconds + 60) {
      return { valid: false, code: 'presentation_not_yet_valid', conclusive: true, reason: 'Presentation is not yet valid' };
    }
    if (presentation.exp < nowSeconds - 60) {
      return { valid: false, code: 'presentation_expired', conclusive: true, reason: 'Presentation has expired' };
    }
    if (trustFreshness === 'expired') {
      return {
        valid: false,
        code: 'trust_snapshot_expired',
        conclusive: false,
        reason: 'QR trust snapshot has expired; synchronization required',
        trust_freshness: trustFreshness,
      };
    }
    const authority = trust.authority_keys.find((key) =>
      key.kid === verifiedPayload.kid &&
      (key.status === 'active' || (key.verify_until != null && key.verify_until >= nowSeconds))
    );
    if (!authority) {
      return {
        valid: false,
        code: 'unknown_authority_key',
        conclusive: trustFreshness === 'current',
        reason: 'QR authority key is not trusted',
        trust_freshness: trustFreshness,
      };
    }
    try {
      if (!p256.verify(
        base64UrlToBytes(envelope.s),
        await digest(verifiedPayload),
        base64UrlToBytes(authority.public_key)
      )) {
        return { valid: false, code: 'invalid_authority_signature', conclusive: true, reason: 'Authority signature invalid', trust_freshness: trustFreshness };
      }
      const unsigned = {
        v: 3,
        c: presentation.c,
        iat: presentation.iat,
        exp: presentation.exp,
        n: presentation.n,
      };
      if (!p256.verify(
        base64UrlToBytes(presentation.s),
        await digest(unsigned),
        base64UrlToBytes(verifiedPayload.dpk)
      )) {
        return { valid: false, code: 'invalid_device_signature', conclusive: true, reason: 'Device signature invalid', trust_freshness: trustFreshness };
      }
    } catch {
      return { valid: false, code: 'invalid_key_or_signature', conclusive: true, reason: 'Invalid signing key or signature', trust_freshness: trustFreshness };
    }
    const cid = credentialUuid(verifiedPayload.cid);
    if (trust.revocations.some((entry) => entry.credential_id === cid)) {
      return { valid: false, code: 'credential_revoked', conclusive: true, reason: 'Credential is revoked', trust_freshness: trustFreshness };
    }
    if (trust.revocations.some((entry) =>
      entry.device_id === verifiedPayload.did &&
      entry.registration_generation != null &&
      entry.registration_generation >= verifiedPayload.rg
    )) {
      return { valid: false, code: 'device_revoked', conclusive: true, reason: 'Pass installation is revoked', trust_freshness: trustFreshness };
    }
    return {
      valid: true,
      code: 'valid',
      conclusive: trustFreshness === 'current',
      trust_freshness: trustFreshness,
      presentation: {
        user_id: verifiedPayload.uid,
        email: '',
        name: '',
        event_id: verifiedPayload.eid,
        credential_id: cid,
        nonce: '',
        assignments: [],
        protocol: 3,
        device_id: verifiedPayload.did,
        credential_generation: verifiedPayload.cg,
        registration_generation: verifiedPayload.rg,
        nonce_hash: await nonceHash(presentation.n),
      },
    };
  }
}

export const QrCredentialService = new QrCredentialServiceClass();
