/* eslint-disable import/first */
const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(async (key: string, value: string) => { mockStore.set(key, value); }),
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  deleteItemAsync: jest.fn(async (key: string) => { mockStore.delete(key); }),
}));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));
jest.mock('../../config', () => ({ API_BASE_URL: 'https://api.example.test' }));

import * as Crypto from 'expo-crypto';
import { ApiClient, ApiError } from '../ApiClient';

const response = (status: number, body: unknown) => ({
  status,
  ok: status >= 200 && status < 300,
  json: jest.fn(async () => body),
});

describe('ApiClient token binding', () => {
  beforeEach(async () => {
    mockStore.clear();
    jest.mocked(Crypto.randomUUID).mockReset()
      .mockReturnValueOnce('token-family-1')
      .mockReturnValueOnce('token-family-2');
    global.fetch = jest.fn();
    await ApiClient.clearTokens();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('rotates on password login, survives refresh, and clears on logout', async () => {
    jest.mocked(global.fetch)
      .mockResolvedValueOnce(response(200, {
        success: true,
        data: {
          user: { id: 2, email: 'scanner@example.com', name: 'Scanner', phone: '1', role: 'scanner', is_active: true },
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
        },
      }) as never)
      .mockResolvedValueOnce(response(401, { success: false }) as never)
      .mockResolvedValueOnce(response(200, {
        success: true,
        data: { accessToken: 'access-2', refreshToken: 'refresh-2' },
      }) as never)
      .mockResolvedValueOnce(response(200, { success: true, data: { ok: true } }) as never)
      .mockResolvedValueOnce(response(200, {
        success: true,
        data: {
          user: { id: 2, email: 'scanner@example.com', name: 'Scanner', phone: '1', role: 'scanner', is_active: true },
          accessToken: 'access-3',
          refreshToken: 'refresh-3',
        },
      }) as never);

    await ApiClient.login('scanner@example.com', 'password');
    expect(ApiClient.getTokenBinding()).toBe('token-family-1');
    await ApiClient.request('/events');
    expect(ApiClient.getTokenBinding()).toBe('token-family-1');

    await ApiClient.login('scanner@example.com', 'password');
    expect(ApiClient.getTokenBinding()).toBe('token-family-2');
    await ApiClient.clearTokens();
    expect(ApiClient.getTokenBinding()).toBeNull();
    expect(mockStore.has('verigate_scan_token_binding')).toBe(false);
  });

  it('preserves safe HTTP status and queue metadata without exposing token fields', async () => {
    jest.mocked(global.fetch)
      .mockResolvedValueOnce(response(200, {
        success: true,
        data: {
          user: { id: 2, email: 'scanner@example.com', name: 'Scanner', phone: '1', role: 'scanner', is_active: true },
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
        },
      }) as never)
      .mockResolvedValueOnce(response(422, {
        success: false,
        error: 'Record rejected',
        data: {
          contract_version: 'queue-ack-v2',
          client_record_id: 'incident-001',
          status: 'rejected',
          accessToken: 'must-not-escape',
          refreshToken: 'must-not-escape',
        },
      }) as never);

    await ApiClient.login('scanner@example.com', 'password');

    const requestPromise = ApiClient.request('/incidents', { method: 'POST' });
    await expect(requestPromise).rejects.toMatchObject({
      name: 'ApiError',
      statusCode: 422,
      responseData: {
        contract_version: 'queue-ack-v2',
        client_record_id: 'incident-001',
        status: 'rejected',
      },
    } satisfies Partial<ApiError>);

    try {
      await requestPromise;
    } catch (error) {
      expect((error as ApiError).responseData).not.toHaveProperty('accessToken');
      expect((error as ApiError).responseData).not.toHaveProperty('refreshToken');
    }
  });

  it('exchanges the account session for a Scan registration bound to the existing installation', async () => {
    jest.mocked(global.fetch)
      .mockResolvedValueOnce(response(200, {
        success: true,
        data: {
          user: { id: 2, email: 'scanner@example.com', name: 'Scanner', phone: '1', role: 'scanner', is_active: true },
          accessToken: 'account-access',
          refreshToken: 'account-refresh',
        },
      }) as never)
      .mockResolvedValueOnce(response(200, {
        success: true,
        data: {
          registration: {
            id: 41,
            event_id: 7,
            app: 'scan',
            installation_id: 'scan-installation',
            state: 'active',
            session_generation: 3,
            version: 4,
          },
          accessToken: 'device-access',
          refreshToken: 'device-refresh',
        },
      }) as never);

    await ApiClient.login('scanner@example.com', 'password');
    const registration = await ApiClient.registerDeviceSession(7, 'scan-installation', 'android');

    expect(registration).toMatchObject({ id: 41, event_id: 7, app: 'scan' });
    expect(ApiClient.hasDeviceSession()).toBe(true);
    expect(jest.mocked(global.fetch).mock.calls[1]).toEqual([
      'https://api.example.test/devices/session',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Idempotency-Key': 'scan-installation:scan:7',
        }),
        body: JSON.stringify({
          event_id: 7,
          app: 'scan',
          installation_id: 'scan-installation',
          platform: 'android',
        }),
      }),
    ]);
  });

  it('releases a never-settling request at its deadline', async () => {
    jest.mocked(global.fetch)
      .mockResolvedValueOnce(response(200, {
        success: true,
        data: {
          user: { id: 2, email: 'scanner@example.com', name: 'Scanner', phone: '1', role: 'scanner', is_active: true },
          accessToken: 'access-1',
          refreshToken: 'refresh-1',
        },
      }) as never)
      .mockImplementationOnce(() => new Promise(() => undefined));
    await ApiClient.login('scanner@example.com', 'password');
    jest.useFakeTimers();

    const pending = ApiClient.request('/sync/users-database', { timeoutMs: 50 });
    const rejection = expect(pending).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
      kind: 'timeout',
    });
    await jest.advanceTimersByTimeAsync(50);

    await rejection;
    jest.useRealTimers();
  });
});
