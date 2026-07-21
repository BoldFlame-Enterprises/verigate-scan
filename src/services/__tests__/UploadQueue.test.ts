/* eslint-disable import/first */
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(async () => null), setItemAsync: jest.fn(async () => undefined) }));
jest.mock('expo-application', () => ({ getAndroidId: jest.fn(() => 'scan-device'), getIosIdForVendorAsync: jest.fn(async () => 'scan-device') }));
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../../config', () => ({ SCAN_UPLOAD_BATCH_SIZE: 25 }));
jest.mock('../ApiClient', () => ({ ApiClient: { isAuthenticated: jest.fn(() => true), request: jest.fn() } }));
jest.mock('../DatabaseService', () => ({
  DatabaseService: {
    getUnsyncedScanLogs: jest.fn(),
    markScanLogsSynced: jest.fn(async () => undefined),
  },
}));

import { ApiClient } from '../ApiClient';
import { DatabaseService } from '../DatabaseService';
import { SyncService } from '../SyncService';

describe('scan upload queue', () => {
  it('partitions by stored event and acknowledges only accepted or duplicate rows', async () => {
    const base = { user_id: 1, user_name: 'User', area: 'Arena', area_id: 3, access_granted: true, scanned_at: '2026-01-01T00:00:00.000Z', scanner_user: 'Scanner' };
    jest.mocked(DatabaseService.getUnsyncedScanLogs).mockResolvedValue([
      { ...base, id: 1, event_id: 4, device_scan_id: 'scan-1' },
      { ...base, id: 2, event_id: 4, device_scan_id: 'scan-2' },
      { ...base, id: 3, event_id: 5, device_scan_id: 'scan-3' },
    ]);
    jest.mocked(ApiClient.request).mockImplementation(async (_path: string, options: any) => ({
      contract_version: 'queue-ack-v2',
      results: options.body.event_id === 4
        ? [{ client_record_id: 'scan-1', status: 'accepted' }, { client_record_id: 'scan-2', status: 'retryable_error' }]
        : [{ client_record_id: 'scan-3', status: 'duplicate' }],
    } as never));

    const uploaded = await (SyncService as any).uploadQueuedScans();

    expect(uploaded).toBe(2);
    expect(ApiClient.request).toHaveBeenCalledTimes(2);
    expect(jest.mocked(ApiClient.request).mock.calls.map((call) => (call[1] as any).body.event_id)).toEqual([4, 5]);
    expect(DatabaseService.markScanLogsSynced).toHaveBeenNthCalledWith(1, [1]);
    expect(DatabaseService.markScanLogsSynced).toHaveBeenNthCalledWith(2, [3]);
  });
});
