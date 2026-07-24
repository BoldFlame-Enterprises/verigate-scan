/* eslint-disable import/first */
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(async () => null), setItemAsync: jest.fn(async () => undefined) }));
jest.mock('expo-application', () => ({ getAndroidId: jest.fn(() => 'scan-device'), getIosIdForVendorAsync: jest.fn(async () => 'scan-device') }));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn(() => 'fallback-device') }));
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../../config', () => ({
  SCAN_UPLOAD_BATCH_SIZE: 25,
  SCAN_UPLOAD_MAX_BATCHES_PER_SYNC: 4,
  AUXILIARY_UPLOAD_BATCH_SIZE: 10,
  AUXILIARY_UPLOAD_MAX_BATCHES_PER_SYNC: 2,
}));
jest.mock('../ApiClient', () => ({
  ApiError: class ApiError extends Error {
    statusCode: number;
    responseData?: Record<string, string>;
    constructor(mockStatusCode: number, mockMessage: string, mockResponseData?: Record<string, string>) {
      super(mockMessage);
      this.name = 'ApiError';
      this.statusCode = mockStatusCode;
      this.responseData = mockResponseData;
    }
  },
  ApiClient: { isAuthenticated: jest.fn(() => true), getTokenBinding: jest.fn(() => 'token-family-1'), request: jest.fn() },
}));
jest.mock('../OfflineSessionService', () => ({
  OfflineSessionService: { refreshProductionBinding: jest.fn(async () => undefined) },
}));
jest.mock('../DeviceIdentityService', () => ({
  DeviceIdentityService: { getInstallationId: jest.fn(async () => 'scan-installation') },
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
    markScanLogsSynced: jest.fn(async () => undefined),
    markIncidentsSynced: jest.fn(async () => undefined),
    markOverridesSynced: jest.fn(async () => undefined),
    recordIncidentFailure: jest.fn(async () => undefined),
    recordOverrideFailure: jest.fn(async () => undefined),
    getUserByEmail: jest.fn(async () => undefined),
  },
}));

import { ApiClient, ApiError } from '../ApiClient';
import { DatabaseService } from '../DatabaseService';
import { SyncService } from '../SyncService';
import { OfflineSessionService } from '../OfflineSessionService';

describe('SyncService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(DatabaseService.getUnsyncedScanLogs).mockResolvedValue([]);
    jest.mocked(DatabaseService.getUnsyncedIncidents).mockResolvedValue([]);
    jest.mocked(DatabaseService.getUnsyncedOverrides).mockResolvedValue([]);
  });

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
      deviceId: 'scan-installation',
      tokenBinding: 'token-family-1',
    });
  });

  it('propagates an auxiliary queue retry as an unsuccessful overall sync', async () => {
    const users = [{ id: 1, event_id: 6, email: 'user@example.com', name: 'User', phone: '1', is_active: true, assignments: [] }];
    const areas = [{ id: 3, name: 'Arena', requires_scan: true }];
    jest.mocked(DatabaseService.getUnsyncedIncidents).mockResolvedValueOnce([{
      id: 1,
      client_record_id: 'incident-retry',
      event_id: 6,
      area: 'Arena',
      area_id: 3,
      category: 'security',
      description: 'Retry me',
      occurred_at: '2026-01-01T00:00:00.000Z',
      attempt_count: 0,
      last_attempt_at: null,
      last_error: null,
      terminal_failure: false,
    }]);
    jest.mocked(ApiClient.request).mockImplementation(async (path: string) => {
      if (path === '/events') return [{ id: 6, name: 'Event', ends_at: null }] as never;
      if (path === '/sync/users-database') return { contract_version: 'event-user-v2', users } as never;
      if (path === '/sync/areas-database') return { areas, qr_authority_public_key: 'authority-key' } as never;
      if (path === '/incidents') throw new ApiError(503, 'Service unavailable');
      return {} as never;
    });

    const result = await SyncService.syncNow();

    expect(result.success).toBe(false);
    expect(result.error).toBe('Incident upload will retry later');
    expect(DatabaseService.recordIncidentFailure).toHaveBeenCalledWith(1, 'Service unavailable', false);
    expect(DatabaseService.getUnsyncedOverrides).not.toHaveBeenCalled();
  });
});
