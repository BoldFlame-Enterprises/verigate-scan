import * as Crypto from 'expo-crypto';
import { p256 } from '@noble/curves/p256';

export const QR_PROTOCOL_VERSION = 'verigate-qr-v2';

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
  ): Promise<{ valid: boolean; reason?: string; presentation?: VerifiedPresentation }> {
    let value: any;
    try {
      value = JSON.parse(encoded);
    } catch {
      return { valid: false, reason: 'Invalid QR format' };
    }

    const payload = value?.payload;
    const credential = payload?.credential;
    if (
      payload?.version !== QR_PROTOCOL_VERSION ||
      credential?.payload?.version !== QR_PROTOCOL_VERSION ||
      !value.device_signature
    ) {
      return { valid: false, reason: 'Unsupported QR credential' };
    }
    if (credential.authority_public_key !== trustedAuthorityPublicKey) {
      return { valid: false, reason: 'Untrusted QR authority' };
    }
    if (credential.payload.event_id !== expectedEventId) {
      return { valid: false, reason: 'QR belongs to a different event' };
    }
    if (
      credential.payload.expires_at < now - 60_000 ||
      payload.expires_at < now - 60_000 ||
      payload.issued_at > now + 60_000 ||
      payload.expires_at - payload.issued_at > 60_000
    ) {
      return { valid: false, reason: 'QR credential expired or not yet valid' };
    }

    try {
      const authoritySpki = base64ToBytes(trustedAuthorityPublicKey);
      const authorityRaw = authoritySpki.slice(authoritySpki.length - 65);
      if (!p256.verify(
        base64ToBytes(credential.authority_signature),
        await digest(credential.payload),
        authorityRaw
      )) {
        return { valid: false, reason: 'Authority signature invalid' };
      }

      const deviceSpki = base64ToBytes(credential.payload.device_public_key);
      const deviceRaw = deviceSpki.slice(deviceSpki.length - 65);
      if (!p256.verify(base64ToBytes(value.device_signature), await digest(payload), deviceRaw)) {
        return { valid: false, reason: 'Device signature invalid' };
      }
    } catch {
      return { valid: false, reason: 'Invalid signing key or signature' };
    }

    return {
      valid: true,
      presentation: {
        user_id: credential.payload.user_id,
        email: credential.payload.email,
        name: credential.payload.name,
        event_id: credential.payload.event_id,
        credential_id: credential.payload.credential_id,
        nonce: payload.nonce,
        assignments: credential.payload.assignments,
      },
    };
  }
}

export const QrCredentialService = new QrCredentialServiceClass();
