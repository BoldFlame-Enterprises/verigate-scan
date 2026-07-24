import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

const INSTALLATION_ID_KEY = 'verigate_scan_installation_id';
const LEGACY_FALLBACK_ID_KEY = 'verigate_scan_fallback_device_id';

type LegacyQueueKind = 'incident' | 'override';

function isReusableIdentity(value: string | null): value is string {
  return value !== null && /^scan-[A-Za-z0-9-]{1,50}$/.test(value);
}

export function legacyQueueRecordId(
  kind: LegacyQueueKind,
  installationId: string,
  localRowId: number
): string {
  return `legacy-${kind}-${installationId}-${localRowId}`;
}

export function legacyQueueRecordPrefix(
  kind: LegacyQueueKind,
  installationId: string
): string {
  return `legacy-${kind}-${installationId}-`;
}

export class DeviceIdentityServiceClass {
  private installationId: string | null = null;
  private pendingIdentity: Promise<string> | null = null;

  async getInstallationId(): Promise<string> {
    if (this.installationId) return this.installationId;
    if (this.pendingIdentity) return this.pendingIdentity;

    this.pendingIdentity = this.loadOrCreateIdentity();
    try {
      this.installationId = await this.pendingIdentity;
      return this.installationId;
    } finally {
      this.pendingIdentity = null;
    }
  }

  private async loadOrCreateIdentity(): Promise<string> {
    const stored = await SecureStore.getItemAsync(INSTALLATION_ID_KEY);
    if (isReusableIdentity(stored)) return stored;

    const legacyFallback = await SecureStore.getItemAsync(LEGACY_FALLBACK_ID_KEY);
    if (isReusableIdentity(legacyFallback)) {
      await SecureStore.setItemAsync(INSTALLATION_ID_KEY, legacyFallback);
      return legacyFallback;
    }

    const created = `scan-${Crypto.randomUUID()}`;
    await SecureStore.setItemAsync(INSTALLATION_ID_KEY, created);
    return created;
  }
}

export const DeviceIdentityService = new DeviceIdentityServiceClass();
