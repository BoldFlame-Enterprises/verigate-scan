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
  ApiClient: { isAuthenticated: jest.fn(() => true), request: jest.fn() },
}));
jest.mock('../DatabaseService', () => ({
  DatabaseService: {
    getUnsyncedScanLogs: jest.fn(),
    markScanLogsSynced: jest.fn(async () => undefined),
    getUnsyncedIncidents: jest.fn(async () => []),
    markIncidentsSynced: jest.fn(async () => undefined),
    recordIncidentFailure: jest.fn(async () => undefined),
    getUnsyncedOverrides: jest.fn(async () => []),
    markOverridesSynced: jest.fn(async () => undefined),
    recordOverrideFailure: jest.fn(async () => undefined),
    getUserByEmail: jest.fn(async () => undefined),
  },
}));
jest.mock('../DeviceIdentityService', () => ({
  DeviceIdentityService: { getInstallationId: jest.fn(async () => 'scan-installation') },
}));

import { ApiClient, ApiError } from '../ApiClient';
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

const incident = (id: number, eventId = 4) => ({
  id,
  client_record_id: `incident-${id}`,
  event_id: eventId,
  area: 'Arena',
  area_id: 3,
  category: 'security',
  description: `Incident ${id}`,
  occurred_at: `2026-01-01T00:00:${String(id).padStart(2, '0')}.000Z`,
  attempt_count: 0,
  last_attempt_at: null,
  last_error: null,
  terminal_failure: false,
});

const override = (id: number, eventId = 4, areaId: number | null = 3) => ({
  id,
  client_record_id: `override-${id}`,
  event_id: eventId,
  user_email: null,
  area: 'Arena',
  area_id: areaId,
  access_granted: true,
  reason: `Override ${id}`,
  occurred_at: `2026-01-01T00:01:${String(id).padStart(2, '0')}.000Z`,
  attempt_count: 0,
  last_attempt_at: null,
  last_error: null,
  terminal_failure: false,
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

describe('incident and override upload queues', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.mocked(DatabaseService.getUnsyncedIncidents).mockResolvedValue([]);
    jest.mocked(DatabaseService.getUnsyncedOverrides).mockResolvedValue([]);
  });

  it('drains at most two incident batches of ten while preserving record identity', async () => {
    jest.mocked(DatabaseService.getUnsyncedIncidents)
      .mockResolvedValueOnce(Array.from({ length: 10 }, (_, index) => incident(index + 1, 40)))
      .mockResolvedValueOnce(Array.from({ length: 10 }, (_, index) => incident(index + 11, 41)));
    jest.mocked(ApiClient.request).mockImplementation(async (_path: string, options: any) => ({
      contract_version: 'queue-ack-v2',
      client_record_id: options.body.client_record_id,
      status: options.body.client_record_id.endsWith('-1') ? 'duplicate' : 'accepted',
    } as never));

    const result = await (SyncService as any).uploadQueuedIncidents();

    expect(result).toEqual({ success: true, uploaded: 20 });
    expect(DatabaseService.getUnsyncedIncidents).toHaveBeenCalledTimes(2);
    expect(DatabaseService.getUnsyncedIncidents).toHaveBeenCalledWith(10);
    expect(ApiClient.request).toHaveBeenCalledTimes(20);
    expect((jest.mocked(ApiClient.request).mock.calls[0][1] as any).body).toMatchObject({
      client_record_id: 'incident-1',
      event_id: 40,
      occurred_at: '2026-01-01T00:00:01.000Z',
    });
    expect((jest.mocked(ApiClient.request).mock.calls[19][1] as any).body.event_id).toBe(41);
  });

  it('retains a structured terminal incident and continues to a later valid row', async () => {
    jest.mocked(DatabaseService.getUnsyncedIncidents).mockResolvedValueOnce([incident(1), incident(2)]);
    jest.mocked(ApiClient.request)
      .mockRejectedValueOnce(new ApiError(422, 'Invalid area', {
        contract_version: 'queue-ack-v2',
        client_record_id: 'incident-1',
        status: 'rejected',
      }))
      .mockResolvedValueOnce({
        contract_version: 'queue-ack-v2',
        client_record_id: 'incident-2',
        status: 'accepted',
      } as never);

    const result = await (SyncService as any).uploadQueuedIncidents();

    expect(result).toEqual({ success: true, uploaded: 1 });
    expect(DatabaseService.recordIncidentFailure).toHaveBeenCalledWith(1, 'Invalid area', true);
    expect(DatabaseService.markIncidentsSynced).toHaveBeenCalledWith([2]);
  });

  it('records one retryable attempt, stops the queue, and never terminals auth failures', async () => {
    jest.mocked(DatabaseService.getUnsyncedIncidents).mockResolvedValueOnce([incident(1), incident(2)]);
    jest.mocked(ApiClient.request).mockRejectedValueOnce(new ApiError(429, 'Rate limited'));

    const retryable = await (SyncService as any).uploadQueuedIncidents();

    expect(retryable.success).toBe(false);
    expect(DatabaseService.recordIncidentFailure).toHaveBeenCalledTimes(1);
    expect(DatabaseService.recordIncidentFailure).toHaveBeenCalledWith(1, 'Rate limited', false);
    expect(ApiClient.request).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    jest.mocked(DatabaseService.getUnsyncedIncidents).mockResolvedValueOnce([incident(3)]);
    jest.mocked(ApiClient.request).mockRejectedValueOnce(new ApiError(401, 'Session expired'));
    const session = await (SyncService as any).uploadQueuedIncidents();

    expect(session.success).toBe(false);
    expect(DatabaseService.recordIncidentFailure).not.toHaveBeenCalled();
    expect(DatabaseService.markIncidentsSynced).not.toHaveBeenCalled();

    jest.clearAllMocks();
    jest.mocked(DatabaseService.getUnsyncedIncidents).mockResolvedValueOnce([incident(4)]);
    jest.mocked(ApiClient.request).mockRejectedValueOnce(new ApiError(403, 'Event access revoked'));
    const forbidden = await (SyncService as any).uploadQueuedIncidents();
    expect(forbidden.success).toBe(false);
    expect(DatabaseService.recordIncidentFailure).not.toHaveBeenCalled();
    expect(DatabaseService.markIncidentsSynced).not.toHaveBeenCalled();
  });

  it('records a network failure once and leaves the row pending', async () => {
    jest.mocked(DatabaseService.getUnsyncedIncidents).mockResolvedValueOnce([incident(1), incident(2)]);
    jest.mocked(ApiClient.request).mockRejectedValueOnce(new Error('Network request failed'));

    const result = await (SyncService as any).uploadQueuedIncidents();

    expect(result.success).toBe(false);
    expect(DatabaseService.recordIncidentFailure).toHaveBeenCalledWith(1, 'Network request failed', false);
    expect(DatabaseService.recordIncidentFailure).toHaveBeenCalledTimes(1);
    expect(DatabaseService.markIncidentsSynced).not.toHaveBeenCalled();
  });

  it('stops after one full invalid-acknowledgement batch without a tight loop', async () => {
    jest.mocked(DatabaseService.getUnsyncedIncidents).mockResolvedValue(
      Array.from({ length: 10 }, (_, index) => incident(index + 1))
    );
    jest.mocked(ApiClient.request).mockResolvedValue({
      contract_version: 'queue-ack-v2',
      client_record_id: 'wrong-record',
      status: 'duplicate',
    } as never);

    const result = await (SyncService as any).uploadQueuedIncidents();

    expect(result.success).toBe(false);
    expect(DatabaseService.getUnsyncedIncidents).toHaveBeenCalledTimes(1);
    expect(ApiClient.request).toHaveBeenCalledTimes(1);
    expect(DatabaseService.recordIncidentFailure).toHaveBeenCalledWith(1, 'Invalid queue acknowledgement', false);
  });

  it('terminals a locally invalid override and continues later rows under stored events', async () => {
    jest.mocked(DatabaseService.getUnsyncedOverrides).mockResolvedValueOnce([
      override(1, 50, null),
      override(2, 51, 7),
    ]);
    jest.mocked(ApiClient.request).mockImplementation(async (_path: string, options: any) => ({
      contract_version: 'queue-ack-v2',
      client_record_id: options.body.client_record_id,
      status: 'duplicate',
    } as never));

    const result = await (SyncService as any).uploadQueuedOverrides();

    expect(result).toEqual({ success: true, uploaded: 1 });
    expect(DatabaseService.recordOverrideFailure).toHaveBeenCalledWith(
      1,
      'Queued override is missing area_id',
      true
    );
    expect((jest.mocked(ApiClient.request).mock.calls[0][1] as any).body).toMatchObject({
      client_record_id: 'override-2',
      event_id: 51,
      area_id: 7,
      occurred_at: '2026-01-01T00:01:02.000Z',
    });
    expect(DatabaseService.markOverridesSynced).toHaveBeenCalledWith([2]);
  });

  it('drains no more than two override batches of ten', async () => {
    jest.mocked(DatabaseService.getUnsyncedOverrides)
      .mockResolvedValueOnce(Array.from({ length: 10 }, (_, index) => override(index + 1, 60)))
      .mockResolvedValueOnce(Array.from({ length: 10 }, (_, index) => override(index + 11, 61)));
    jest.mocked(ApiClient.request).mockImplementation(async (_path: string, options: any) => ({
      contract_version: 'queue-ack-v2',
      client_record_id: options.body.client_record_id,
      status: 'accepted',
    } as never));

    const result = await (SyncService as any).uploadQueuedOverrides();

    expect(result).toEqual({ success: true, uploaded: 20 });
    expect(DatabaseService.getUnsyncedOverrides).toHaveBeenCalledTimes(2);
    expect(DatabaseService.getUnsyncedOverrides).toHaveBeenCalledWith(10);
    expect(ApiClient.request).toHaveBeenCalledTimes(20);
    expect((jest.mocked(ApiClient.request).mock.calls[19][1] as any).body.event_id).toBe(61);
  });
});
