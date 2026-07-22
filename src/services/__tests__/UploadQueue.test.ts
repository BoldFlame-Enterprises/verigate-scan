/* eslint-disable import/first */
jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn(async () => null), setItemAsync: jest.fn(async () => undefined) }));
jest.mock('expo-application', () => ({ getAndroidId: jest.fn(() => 'scan-device'), getIosIdForVendorAsync: jest.fn(async () => 'scan-device') }));
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../../config', () => ({ SCAN_UPLOAD_BATCH_SIZE: 25, SCAN_UPLOAD_MAX_BATCHES_PER_SYNC: 4 }));
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

const base = {
  user_id: 1,
  user_name: 'User',
  area: 'Arena',
  area_id: 3,
  access_granted: true,
  scanned_at: '2026-01-01T00:00:00.000Z',
  scanner_user: 'Scanner',
};

const record = (id: number, eventId = 4) => ({
  ...base,
  id,
  event_id: eventId,
  device_scan_id: `scan-${id}`,
});

describe('scan upload queue', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('partitions by stored event and acknowledges only accepted or duplicate rows', async () => {
    jest.mocked(DatabaseService.getUnsyncedScanLogs).mockResolvedValue([
      record(1, 4),
      record(2, 4),
      record(3, 5),
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

  it('drains no more than four batches of 25 in one synchronization', async () => {
    const queued = Array.from({ length: 125 }, (_, index) => record(index + 1));
    let read = 0;
    jest.mocked(DatabaseService.getUnsyncedScanLogs).mockImplementation(async () => {
      const batch = queued.slice(read, read + 25);
      read += 25;
      return batch;
    });
    jest.mocked(ApiClient.request).mockImplementation(async (_path: string, options: any) => ({
      contract_version: 'queue-ack-v2',
      results: options.body.logs.map((log: { client_record_id: string }) => ({
        client_record_id: log.client_record_id,
        status: 'accepted',
      })),
    } as never));

    const uploaded = await (SyncService as any).uploadQueuedScans();

    expect(uploaded).toBe(100);
    expect(DatabaseService.getUnsyncedScanLogs).toHaveBeenCalledTimes(4);
    expect(DatabaseService.getUnsyncedScanLogs).toHaveBeenCalledWith(25);
    expect(ApiClient.request).toHaveBeenCalledTimes(4);
    expect(DatabaseService.markScanLogsSynced).toHaveBeenLastCalledWith(
      Array.from({ length: 25 }, (_, index) => index + 76),
    );
  });

  it('stops after a retryable acknowledgement and leaves that record queued', async () => {
    jest.mocked(DatabaseService.getUnsyncedScanLogs)
      .mockResolvedValueOnce(Array.from({ length: 25 }, (_, index) => record(index + 1)))
      .mockResolvedValueOnce([record(26)]);
    jest.mocked(ApiClient.request).mockImplementation(async (_path: string, options: any) => ({
      contract_version: 'queue-ack-v2',
      results: options.body.logs.map((log: { client_record_id: string }, index: number) => ({
        client_record_id: log.client_record_id,
        status: index === 24 ? 'retryable_error' : 'accepted',
      })),
    } as never));

    const uploaded = await (SyncService as any).uploadQueuedScans();

    expect(uploaded).toBe(24);
    expect(DatabaseService.getUnsyncedScanLogs).toHaveBeenCalledTimes(1);
    expect(DatabaseService.markScanLogsSynced).toHaveBeenCalledWith(
      Array.from({ length: 24 }, (_, index) => index + 1),
    );
    expect(DatabaseService.markScanLogsSynced).not.toHaveBeenCalledWith(expect.arrayContaining([25]));
  });

  it('stops without looping when a full batch makes no acknowledgement progress', async () => {
    jest.mocked(DatabaseService.getUnsyncedScanLogs).mockResolvedValue(
      Array.from({ length: 25 }, (_, index) => record(index + 1)),
    );
    jest.mocked(ApiClient.request).mockImplementation(async (_path: string, options: any) => ({
      contract_version: 'queue-ack-v2',
      results: options.body.logs.map((log: { client_record_id: string }) => ({
        client_record_id: log.client_record_id,
        status: 'rejected',
      })),
    } as never));

    const uploaded = await (SyncService as any).uploadQueuedScans();

    expect(uploaded).toBe(0);
    expect(DatabaseService.getUnsyncedScanLogs).toHaveBeenCalledTimes(1);
    expect(DatabaseService.markScanLogsSynced).toHaveBeenCalledWith([]);
  });
});
