import Constants from 'expo-constants';

export const API_BASE_URL: string =
  process.env.EXPO_PUBLIC_API_URL ||
  (Constants.expoConfig?.extra?.apiBaseUrl as string | undefined) ||
  'http://localhost:3000/api';

export const DEMO_MODE: boolean =
  process.env.EXPO_PUBLIC_DEMO_MODE === 'true' ||
  Constants.expoConfig?.extra?.demoMode === true;

export const SYNC_STALE_WARNING_MS = 60 * 1000;
export const SCAN_UPLOAD_BATCH_SIZE = 25;
export const SCAN_UPLOAD_MAX_BATCHES_PER_SYNC = 4;
export const AUXILIARY_UPLOAD_BATCH_SIZE = 10;
export const AUXILIARY_UPLOAD_MAX_BATCHES_PER_SYNC = 2;
