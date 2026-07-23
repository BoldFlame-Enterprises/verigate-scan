/* eslint-disable import/first */
jest.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 4 },
  SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
  setNotificationHandler: jest.fn(),
  requestPermissionsAsync: jest.fn(async () => ({ status: 'granted' })),
  setNotificationChannelAsync: jest.fn(async () => undefined),
  cancelScheduledNotificationAsync: jest.fn(async () => undefined),
  scheduleNotificationAsync: jest.fn(async () => 'notification-id'),
}));
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('../../config', () => ({ SYNC_STALE_WARNING_MS: 15 * 60 * 1000 }));

import * as Notifications from 'expo-notifications';
import { NotificationService } from '../NotificationService';

describe('NotificationService local lifecycle', () => {
  beforeEach(() => jest.clearAllMocks());

  it('cancels the session-local stale warning idempotently', async () => {
    jest.mocked(Notifications.cancelScheduledNotificationAsync)
      .mockRejectedValueOnce(new Error('already absent'))
      .mockResolvedValueOnce(undefined);

    await expect(NotificationService.cancelStaleWarning()).resolves.toBeUndefined();
    await expect(NotificationService.cancelStaleWarning()).resolves.toBeUndefined();
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenNthCalledWith(1, 'sync-stale-warning');
    expect(Notifications.cancelScheduledNotificationAsync).toHaveBeenNthCalledWith(2, 'sync-stale-warning');
  });
});
