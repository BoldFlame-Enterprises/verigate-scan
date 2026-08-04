/* eslint-disable import/first */
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));
jest.mock('expo-application', () => ({ getAndroidId: jest.fn(() => 'scan-device'), getIosIdForVendorAsync: jest.fn(async () => 'scan-device') }));
jest.mock('expo-crypto', () => ({
  randomUUID: jest.fn(() => 'fallback-device'),
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  CryptoEncoding: { HEX: 'hex' },
  digestStringAsync: jest.fn(async () => 'a'.repeat(64)),
}));
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
  ApiClient: {
    isAuthenticated: jest.fn(() => true),
    hasDeviceSession: jest.fn(() => true),
    getDeviceEventId: jest.fn(() => 6),
    getTokenBinding: jest.fn(() => 'token-family-1'),
    getTransitionAuditCredentials: jest.fn(async () => []),
    removeTransitionAuditCredential: jest.fn(async () => undefined),
    request: jest.fn(),
  },
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
    stageQrTrustPage: jest.fn(async () => undefined),
    promoteAuthorizationSnapshot: jest.fn(async () => undefined),
    hasAuthorizationSnapshot: jest.fn(async () => false),
    quarantineEventScanLogs: jest.fn(async () => undefined),
    purgeIfEventExpired: jest.fn(async () => false),
    getUnsyncedScanLogs: jest.fn(async () => []),
    getUnsyncedIncidents: jest.fn(async () => []),
    getUnsyncedOverrides: jest.fn(async () => []),
    recordScanUploadOutcomes: jest.fn(async () => undefined),
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
import * as SecureStore from 'expo-secure-store';

const trustPage = {
  contract_version: 'qr-trust-v1',
  event_id: 6,
  snapshot_generation: 2,
  generated_at: '2026-07-29T00:00:00.000Z',
  hard_expires_at: '2026-07-30T00:00:00.000Z',
  authority_keys: [],
  revocations: [],
  has_more: false,
  next_cursor: 'cursor-2',
  checksum: 'a'.repeat(64),
};

const authorizationManifest = {
  contract_version: 'authorization-manifest-v1',
  event_id: 6,
  checksum: 'b'.repeat(64),
  trust_generation: 2,
  generated_at: '2026-07-29T00:00:00.000Z',
  event: { name: 'Event 6', is_active: true, starts_at: null, ends_at: null },
  counts: { users: 1, areas: 1 },
};

describe('SyncService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === 'verigate_scan_event_active') return 'true';
      if (key === 'verigate_scan_event_name') return 'Event 6';
      return null;
    });
    jest.mocked(DatabaseService.getUnsyncedScanLogs).mockResolvedValue([]);
    jest.mocked(DatabaseService.getUnsyncedIncidents).mockResolvedValue([]);
    jest.mocked(DatabaseService.getUnsyncedOverrides).mockResolvedValue([]);
    jest.mocked(DatabaseService.hasAuthorizationSnapshot).mockResolvedValue(false);
    jest.mocked(ApiClient.getTransitionAuditCredentials).mockResolvedValue([]);
  });

  it('stores the lossless user projection and trusted event QR authority', async () => {
    const users = [{ id: 1, event_id: 6, email: 'user@example.com', name: 'User', phone: '1', is_active: true, assignments: [] }];
    const areas = [{ id: 3, name: 'Arena', requires_scan: true }];
    jest.mocked(ApiClient.request).mockImplementation(async (path: string, options = {}) => {
      if (path === '/sync/areas-database' && options?.params?.view === 'manifest') return authorizationManifest as never;
      if (path === '/events') return [{ id: 6, name: 'Event', ends_at: null }] as never;
      if (path === '/sync/users-database') return { contract_version: 'event-user-v2', users } as never;
      if (path === '/sync/areas-database') return { areas, qr_authority_public_key: 'authority-key' } as never;
      if (path === '/sync/qr-trust') return trustPage as never;
      return {} as never;
    });

    const result = await SyncService.syncNow();
    expect(result.success).toBe(true);
    expect(ApiClient.request).not.toHaveBeenCalledWith('/events');
    expect(DatabaseService.promoteAuthorizationSnapshot).toHaveBeenCalledWith({
      eventId: 6,
      event: {
        name: 'Event 6',
        is_active: true,
        starts_at: null,
        ends_at: null,
      },
      trustGeneration: 2,
      users,
      areas,
      legacyAuthorityPublicKey: 'authority-key',
    });
    expect(OfflineSessionService.refreshProductionBinding).toHaveBeenCalledWith({
      eventId: 6,
      deviceId: 'scan-installation',
      tokenBinding: 'token-family-1',
    });
  });

  it('skips unchanged authorization downloads while still completing queue and heartbeat work', async () => {
    jest.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === 'verigate_scan_event_active') return 'true';
      if (key === 'verigate_scan_event_name') return 'Event 6';
      if (key === 'verigate_scan_authorization_manifest') {
        return JSON.stringify({ eventId: 6, checksum: 'b'.repeat(64), users: 12, areas: 3 });
      }
      return null;
    });
    jest.mocked(DatabaseService.hasAuthorizationSnapshot).mockResolvedValue(true);
    jest.mocked(ApiClient.request).mockImplementation(async (path: string, options = {}) => {
      if (path === '/sync/areas-database' && options.params?.view === 'manifest') return {
        ...authorizationManifest,
        counts: { users: 12, areas: 3 },
      } as never;
      return {} as never;
    });

    await expect(SyncService.syncNow()).resolves.toMatchObject({
      success: true,
      userCount: 12,
      areaCount: 3,
    });
    expect(ApiClient.request).not.toHaveBeenCalledWith('/sync/users-database', expect.anything());
    expect(jest.mocked(ApiClient.request).mock.calls.filter(
      ([path, options]) => path === '/sync/areas-database' && options?.params?.view !== 'manifest'
    )).toHaveLength(0);
    expect(ApiClient.request).not.toHaveBeenCalledWith('/sync/qr-trust', expect.anything());
    expect(DatabaseService.promoteAuthorizationSnapshot).not.toHaveBeenCalled();
    expect(ApiClient.request).toHaveBeenCalledWith('/notifications/sync-heartbeat', expect.anything());
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
    jest.mocked(ApiClient.request).mockImplementation(async (path: string, options = {}) => {
      if (path === '/sync/areas-database' && options.params?.view === 'manifest') return authorizationManifest as never;
      if (path === '/events') return [{ id: 6, name: 'Event', ends_at: null }] as never;
      if (path === '/sync/users-database') return { contract_version: 'event-user-v2', users } as never;
      if (path === '/sync/areas-database') return { areas, qr_authority_public_key: 'authority-key' } as never;
      if (path === '/sync/qr-trust') return trustPage as never;
      if (path === '/incidents') throw new ApiError(503, 'Service unavailable');
      return {} as never;
    });

    const result = await SyncService.syncNow();

    expect(result.success).toBe(false);
    expect(result.error).toBe('Incident upload will retry later');
    expect(DatabaseService.recordIncidentFailure).toHaveBeenCalledWith(1, 'Service unavailable', false);
    expect(DatabaseService.getUnsyncedOverrides).not.toHaveBeenCalled();
  });

  it('does not promote a partially staged trust snapshot when pagination changes generation', async () => {
    const users = [{ id: 1, event_id: 6, email: 'user@example.com', name: 'User', phone: '1', is_active: true, assignments: [] }];
    const areas = [{ id: 3, name: 'Arena', requires_scan: true }];
    let trustRequest = 0;
    jest.mocked(ApiClient.request).mockImplementation(async (path: string, options = {}) => {
      if (path === '/sync/areas-database' && options.params?.view === 'manifest') return authorizationManifest as never;
      if (path === '/events') return [{ id: 6, name: 'Event', ends_at: null }] as never;
      if (path === '/sync/users-database') return { contract_version: 'event-user-v2', users } as never;
      if (path === '/sync/areas-database') return { areas, qr_authority_public_key: 'authority-key' } as never;
      if (path === '/sync/qr-trust') {
        trustRequest += 1;
        return {
          ...trustPage,
          snapshot_generation: trustRequest === 1 ? 2 : 3,
          has_more: trustRequest === 1,
          next_cursor: trustRequest === 1 ? 'cursor-1' : 'cursor-3',
        } as never;
      }
      return {} as never;
    });

    const result = await SyncService.syncNow();

    expect(result).toMatchObject({
      success: false,
      error: 'QR trust snapshot changed during pagination',
    });
    expect(DatabaseService.stageQrTrustPage).toHaveBeenCalledTimes(1);
    expect(DatabaseService.promoteAuthorizationSnapshot).not.toHaveBeenCalled();
  });

  it('does not promote downloads when the manifest changes during synchronization', async () => {
    let manifestRequest = 0;
    jest.mocked(ApiClient.request).mockImplementation(async (path: string, options = {}) => {
      if (path === '/sync/areas-database' && options.params?.view === 'manifest') {
        manifestRequest += 1;
        return {
          ...authorizationManifest,
          checksum: (manifestRequest === 1 ? 'b' : 'c').repeat(64),
        } as never;
      }
      if (path === '/sync/users-database') return { contract_version: 'event-user-v2', users: [] } as never;
      if (path === '/sync/areas-database') return { areas: [], qr_authority_public_key: 'authority-key' } as never;
      if (path === '/sync/qr-trust') return trustPage as never;
      return {} as never;
    });

    await expect(SyncService.syncNow()).resolves.toMatchObject({
      success: false,
      error: 'Authorization snapshot changed during synchronization',
    });
    expect(DatabaseService.promoteAuthorizationSnapshot).not.toHaveBeenCalled();
  });
});
