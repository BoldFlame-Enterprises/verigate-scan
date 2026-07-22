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
import { ApiClient } from '../ApiClient';

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
});
