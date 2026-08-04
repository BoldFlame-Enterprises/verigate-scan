import * as SecureStore from 'expo-secure-store';
import {
  ApiClient,
  deviceControlReason,
  DeviceControlReason,
} from './ApiClient';
import { OfflineSessionService } from './OfflineSessionService';
import { SyncScheduler } from './SyncScheduler';
import { DeregistrationAuditService } from './DeregistrationAuditService';

const DEVICE_NOTICE_KEY = 'verigate_scan_device_control_notice';
const DEVICE_CONTROL_STATE_KEY = 'verigate_scan_device_control_state';

export interface DeviceControlNotice {
  reason: DeviceControlReason;
  message: string;
  createdAt: number;
}

export type DeviceStateCheck =
  | { status: 'active' }
  | { status: 'offline' }
  | { status: 'revoked'; reason: DeviceControlReason };

export type StoredDeviceControlState = DeviceControlReason | 'unknown';

class DeviceControlServiceClass {
  private listeners = new Set<(reason: DeviceControlReason) => void | Promise<void>>();

  subscribe(listener: (reason: DeviceControlReason) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async clearRevocationMarker(): Promise<void> {
    await SecureStore.deleteItemAsync(DEVICE_CONTROL_STATE_KEY);
  }

  async getStoredControlState(): Promise<StoredDeviceControlState> {
    const stored = await SecureStore.getItemAsync(DEVICE_CONTROL_STATE_KEY);
    return stored === 'deregistered' || stored === 'blacklisted' ? stored : 'unknown';
  }

  async revoke(reason: DeviceControlReason): Promise<void> {
    SyncScheduler.stop();
    await SecureStore.setItemAsync(DEVICE_CONTROL_STATE_KEY, reason);
    if (reason === 'deregistered') {
      try {
        const eventId = ApiClient.getDeviceEventId();
        if (!eventId) throw new Error('Deregistered device event binding is unavailable');
        const credential = await ApiClient.obtainAuditCredential();
        const auditSession = {
          eventId,
          cutoff: credential.state_changed_at,
          deadline: credential.expires_at,
          accessToken: credential.accessToken,
        };
        await DeregistrationAuditService.begin(auditSession);
        await DeregistrationAuditService.resume();
      } catch {
        // Unacknowledged audit rows remain inspectable for later support.
      }
    } else {
      await DeregistrationAuditService.cancelForBlacklist();
      await ApiClient.clearAuditCredential();
    }
    await Promise.allSettled([
      OfflineSessionService.clear(),
      ApiClient.clearTokens(),
    ]);
    const message = reason === 'blacklisted'
      ? 'This device was blacklisted for this event. You need to log in again after an event administrator removes it from the blacklist.'
      : 'This device was deregistered for this event. You need to log in again to re-register the app.';
    await SecureStore.setItemAsync(DEVICE_NOTICE_KEY, JSON.stringify({
      reason,
      message,
      createdAt: Date.now(),
    } satisfies DeviceControlNotice));
    await Promise.allSettled(
      Array.from(this.listeners, (listener) => Promise.resolve(listener(reason)))
    );
  }

  async checkConnectedState(): Promise<DeviceStateCheck> {
    if (!ApiClient.isAuthenticated() || !ApiClient.hasDeviceSession()) return { status: 'offline' };
    try {
      await ApiClient.getDeviceState();
      return { status: 'active' };
    } catch (error) {
      const reason = deviceControlReason(error);
      if (!reason) return { status: 'offline' };
      await this.revoke(reason);
      return { status: 'revoked', reason };
    }
  }

  async consumeNotice(): Promise<DeviceControlNotice | null> {
    const stored = await SecureStore.getItemAsync(DEVICE_NOTICE_KEY);
    if (!stored) return null;
    await SecureStore.deleteItemAsync(DEVICE_NOTICE_KEY);
    try {
      return JSON.parse(stored) as DeviceControlNotice;
    } catch {
      return null;
    }
  }
}

export const DeviceControlService = new DeviceControlServiceClass();
