import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { SYNC_STALE_WARNING_MS } from '../config';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

const SYNC_STALE_NOTIFICATION_ID = 'sync-stale-warning';

/**
 * Local-only notifications for the scanner app - there is no
 * remote push here by design; scanners are expected to be actively working
 * the device, so the useful signal is "you're operating on stale data,"
 * scheduled fresh after every successful sync.
 */
class NotificationServiceClass {
  async init(): Promise<void> {
    const { status } = await Notifications.requestPermissionsAsync();
    if (status !== 'granted') {
      console.warn('Notification permission not granted - sync-stale warnings disabled');
      return;
    }
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'VeriGate Scan',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }
  }

  /** Call after every successful (or attempted) sync to push the stale-data
   * warning out by SYNC_STALE_WARNING_MS from now. */
  async scheduleStaleWarning(): Promise<void> {
    await Notifications.cancelScheduledNotificationAsync(SYNC_STALE_NOTIFICATION_ID).catch(() => undefined);
    await Notifications.scheduleNotificationAsync({
      identifier: SYNC_STALE_NOTIFICATION_ID,
      content: {
        title: 'Scanner data may be out of date',
        body: 'This device has not synced recently. Reconnect and sync before continuing to scan.',
        data: { type: 'sync_stale' },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: SYNC_STALE_WARNING_MS / 1000, repeats: false },
    });
  }

  async cancelStaleWarning(): Promise<void> {
    await Notifications.cancelScheduledNotificationAsync(SYNC_STALE_NOTIFICATION_ID).catch(() => undefined);
  }
}

export const NotificationService = new NotificationServiceClass();
