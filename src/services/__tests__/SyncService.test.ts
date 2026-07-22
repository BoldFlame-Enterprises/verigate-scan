/* eslint-disable import/first */
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(async () => null), setItemAsync: jest.fn(async () => undefined) }));
jest.mock('expo-application', () => ({ getAndroidId: jest.fn(() => 'scan-device'), getIosIdForVendorAsync: jest.fn(async () => 'scan-device') }));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'fallback-device') }));
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../../config', () => ({ SCAN_UPLOAD_BATCH_SIZE: 25 }));
jest.mock('../ApiClient', () => ({ ApiClient: { isAuthenticated: jest.fn(() => true), getTokenBinding: jest.fn(() => 'token-family-1'), request: jest.fn() } }));
jest.mock('../OfflineSessionService', () => ({
  OfflineSessionService: { refreshProductionBinding: jest.fn(async () => undefined) },
}));
jest.mock('../DatabaseService', () => ({
  DatabaseService: {
    upsertSyncedUsers: jest.fn(async () => undefined),
    upsertSyncedAreas: jest.fn(async () => undefined),
    setQrAuthorityPublicKey: jest.fn(async () => undefined),
    purgeIfEventExpired: jest.fn(async () => false),
    getUnsyncedScanLogs: jest.fn(async () => []),
    getUnsyncedIncidents: jest.fn(async () => []),
    getUnsyncedOverrides: jest.fn(async () => []),
    markIncidentsSynced: jest.fn(async () => undefined),
    markOverridesSynced: jest.fn(async () => undefined),
  },
}));

import { ApiClient } from '../ApiClient';
import { DatabaseService } from '../DatabaseService';
import { SyncService } from '../SyncService';
import { OfflineSessionService } from '../OfflineSessionService';

describe('SyncService', () => {
  it('stores the lossless user projection and trusted event QR authority', async () => {
    const users = [{ id: 1, event_id: 6, email: 'user@example.com', name: 'User', phone: '1', is_active: true, assignments: [] }];
    const areas = [{ id: 3, name: 'Arena', requires_scan: true }];
    jest.mocked(ApiClient.request).mockImplementation(async (path: string) => {
      if (path === '/events') return [{ id: 6, name: 'Event', ends_at: null }] as never;
      if (path === '/sync/users-database') return { contract_version: 'event-user-v2', users } as never;
      if (path === '/sync/areas-database') return { areas, qr_authority_public_key: 'authority-key' } as never;
      return {} as never;
    });

    const result = await SyncService.syncNow();
    expect(result.success).toBe(true);
    expect(DatabaseService.upsertSyncedUsers).toHaveBeenCalledWith(6, users);
    expect(DatabaseService.setQrAuthorityPublicKey).toHaveBeenCalledWith(6, 'authority-key');
    expect(OfflineSessionService.refreshProductionBinding).toHaveBeenCalledWith({
      eventId: 6,
      deviceId: 'scan-device',
      tokenBinding: 'token-family-1',
    });
  });
});
