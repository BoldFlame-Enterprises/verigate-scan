/* eslint-disable import/first */
const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => { mockStore.set(key, value); }),
  deleteItemAsync: jest.fn(async (key: string) => { mockStore.delete(key); }),
}));
jest.mock('../ApiClient', () => ({
  ApiClient: {
    isAuthenticated: jest.fn(() => true),
    hasDeviceSession: jest.fn(() => true),
    getDeviceEventId: jest.fn(() => 4),
    getDeviceState: jest.fn(),
    obtainAuditCredential: jest.fn(),
    clearTokens: jest.fn(async () => undefined),
    clearAuditCredential: jest.fn(async () => undefined),
  },
  ApiError: class ApiError extends Error {
    statusCode: number;
    code?: string;
    constructor(statusCode: number, message: string, _responseData?: unknown, code?: string) {
      super(message);
      this.statusCode = statusCode;
      this.code = code;
    }
  },
  deviceControlReason: (error: { code?: string }) => {
    if (error.code === 'DEVICE_BLACKLISTED') return 'blacklisted';
    if (error.code?.startsWith('DEVICE_')) return 'deregistered';
    return null;
  },
}));
jest.mock('../OfflineSessionService', () => ({
  OfflineSessionService: { clear: jest.fn(async () => undefined) },
}));
jest.mock('../SyncScheduler', () => ({
  SyncScheduler: { stop: jest.fn() },
}));
jest.mock('../SyncService', () => ({
  SyncService: { drainDeregisteredAuditQueues: jest.fn(async () => ({ uploaded: 3 })) },
}));

import { ApiClient, ApiError } from '../ApiClient';
import { DeviceControlService } from '../DeviceControlService';
import { OfflineSessionService } from '../OfflineSessionService';
import { SyncScheduler } from '../SyncScheduler';
import { SyncService } from '../SyncService';

describe('Scan connected device enforcement', () => {
  beforeEach(() => {
    mockStore.clear();
    jest.clearAllMocks();
  });

  it('stops scanning and drains only through the bounded audit credential after deregistration', async () => {
    jest.mocked(ApiClient.getDeviceState).mockRejectedValue(
      new ApiError(401, 'Registration revoked', undefined, 'DEVICE_DEREGISTERED')
    );
    jest.mocked(ApiClient.obtainAuditCredential).mockResolvedValue({
      accessToken: 'audit-token',
      expires_at: '2026-07-27T12:15:00.000Z',
      state_changed_at: '2026-07-27T12:00:00.000Z',
    });
    const listener = jest.fn();
    const unsubscribe = DeviceControlService.subscribe(listener);

    const result = await DeviceControlService.checkConnectedState();

    expect(result).toEqual({ status: 'revoked', reason: 'deregistered' });
    expect(SyncScheduler.stop).toHaveBeenCalled();
    expect(SyncService.drainDeregisteredAuditQueues).toHaveBeenCalledWith({
      eventId: 4,
      cutoff: '2026-07-27T12:00:00.000Z',
      deadline: '2026-07-27T12:15:00.000Z',
      accessToken: 'audit-token',
    });
    expect(OfflineSessionService.clear).toHaveBeenCalled();
    expect(ApiClient.clearTokens).toHaveBeenCalled();
    expect(listener).toHaveBeenCalledWith('deregistered');
    unsubscribe();
  });

  it('performs zero final upload after blacklisting and keeps a login notice outside auth state', async () => {
    jest.mocked(ApiClient.getDeviceState).mockRejectedValue(
      new ApiError(401, 'Registration blocked', undefined, 'DEVICE_BLACKLISTED')
    );

    await DeviceControlService.checkConnectedState();

    expect(ApiClient.obtainAuditCredential).not.toHaveBeenCalled();
    expect(SyncService.drainDeregisteredAuditQueues).not.toHaveBeenCalled();
    expect(ApiClient.clearAuditCredential).toHaveBeenCalled();
    expect(await DeviceControlService.consumeNotice()).toMatchObject({
      reason: 'blacklisted',
      message: expect.stringMatching(/log in again/i),
    });
  });

  it('does not claim revocation while the connected state check is offline', async () => {
    jest.mocked(ApiClient.getDeviceState).mockRejectedValue(new TypeError('Network request failed'));

    await expect(DeviceControlService.checkConnectedState()).resolves.toEqual({ status: 'offline' });
    expect(ApiClient.clearTokens).not.toHaveBeenCalled();
    expect(SyncScheduler.stop).not.toHaveBeenCalled();
  });
});
