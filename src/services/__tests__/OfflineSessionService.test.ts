/* eslint-disable import/first */
const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  setItemAsync: jest.fn(async (key: string, value: string) => { mockStore.set(key, value); }),
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  deleteItemAsync: jest.fn(async (key: string) => { mockStore.delete(key); }),
}));

import { OfflineSessionService } from '../OfflineSessionService';

describe('OfflineSessionService', () => {
  beforeEach(() => {
    mockStore.clear();
    jest.restoreAllMocks();
  });

  it('expires a previously authenticated scanner session after 24 hours', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(5_000);
    await OfflineSessionService.create(2, 'scanner@example.com', 11, 'production');
    expect(await OfflineSessionService.getValid()).toMatchObject({ userId: 2, eventId: 11, mode: 'production' });

    jest.spyOn(Date, 'now').mockReturnValue(5_000 + 24 * 60 * 60 * 1000 + 1);
    expect(await OfflineSessionService.getValid()).toBeNull();
  });
});
