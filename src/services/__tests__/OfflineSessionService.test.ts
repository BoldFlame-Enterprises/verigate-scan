/* eslint-disable import/first */
const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(async (key: string, value: string) => { mockStore.set(key, value); }),
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  deleteItemAsync: jest.fn(async (key: string) => { mockStore.delete(key); }),
}));

import { OfflineSessionService } from '../OfflineSessionService';

const expected = {
  userId: 2,
  email: 'scanner@example.com',
  eventId: 11,
  deviceId: 'scanner-device-1',
  tokenBinding: 'token-family-1',
};

describe('OfflineSessionService', () => {
  beforeEach(() => {
    mockStore.clear();
    jest.restoreAllMocks();
  });

  it('returns a fully bound scanner session only within its 24-hour limit', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(5_000);
    await OfflineSessionService.create(2, expected.email, 11, 'production', expected);
    expect(await OfflineSessionService.getValid(expected)).toMatchObject({
      schemaVersion: 3,
      userId: 2,
      eventId: 11,
      mode: 'production',
      deviceId: 'scanner-device-1',
      tokenBinding: 'token-family-1',
    });

    jest.spyOn(Date, 'now').mockReturnValue(5_000 + 24 * 60 * 60 * 1000 + 1);
    expect(await OfflineSessionService.getValid(expected)).toBeNull();
  });

  it.each([
    ['identity', { ...expected, userId: 3 }],
    ['event', { ...expected, eventId: 12 }],
    ['device', { ...expected, deviceId: 'scanner-device-2' }],
    ['token family', { ...expected, tokenBinding: 'token-family-2' }],
  ])('rejects and clears a scanner session with a mismatched %s binding', async (_label, mismatch) => {
    await OfflineSessionService.create(2, expected.email, 11, 'production', expected);
    expect(await OfflineSessionService.getValid(mismatch)).toBeNull();
    expect(await OfflineSessionService.getMetadata()).toBeNull();
  });

  it('rejects a legacy scanner session without device and token bindings', async () => {
    mockStore.set('verigate_scan_offline_session_v2', JSON.stringify({
      userId: 2,
      email: expected.email,
      eventId: 11,
      mode: 'production',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }));
    expect(await OfflineSessionService.getMetadata(expected.email)).toBeNull();
  });

  it('keeps demo sessions device-bound without a production token family', async () => {
    await OfflineSessionService.create(2, expected.email, 0, 'demo', {
      deviceId: expected.deviceId,
      tokenBinding: null,
    });
    expect(await OfflineSessionService.getValid({
      ...expected,
      eventId: 0,
      tokenBinding: null,
    })).toMatchObject({ mode: 'demo', deviceId: expected.deviceId });
  });

  it('refreshes the synchronized event without extending the offline lifetime', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(7_000);
    await OfflineSessionService.create(2, expected.email, 11, 'production', expected);
    await OfflineSessionService.refreshProductionBinding({
      eventId: 12,
      deviceId: expected.deviceId,
      tokenBinding: expected.tokenBinding,
    });

    expect(await OfflineSessionService.getValid({ ...expected, eventId: 12 })).toMatchObject({
      eventId: 12,
      issuedAt: 7_000,
      expiresAt: 7_000 + 24 * 60 * 60 * 1000,
    });
  });
});
