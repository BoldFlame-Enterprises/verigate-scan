import Constants from 'expo-constants';

type BuildPlatform = 'android' | 'ios';

interface PublicRuntimeEnvironment {
  apiBaseUrl?: string;
  demoMode?: string;
}

interface ResolvedRuntimeConfig {
  apiBaseUrl: string;
  buildProfile: string | null;
  buildPlatform: BuildPlatform | null;
  demoMode: boolean;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function booleanValue(value: string | undefined, fallback: boolean, label: string): boolean {
  if (value === undefined || value === '') return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${label} must be either true or false`);
}

function safeProfiledApiUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('The profiled Scan API URL is malformed');
  }
  const hostname = parsed.hostname.toLowerCase();
  const loopback = hostname === 'localhost' || hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  const pathname = parsed.pathname.replace(/\/$/, '');
  if (
    parsed.protocol !== 'https:' || loopback || pathname !== '/api' ||
    parsed.username || parsed.password || parsed.search || parsed.hash
  ) {
    throw new Error('The profiled Scan API URL must be a credential-free HTTPS origin ending in /api');
  }
  parsed.pathname = pathname;
  return parsed.toString().replace(/\/$/, '');
}

export function resolveRuntimeConfig(
  configuredExtra: Record<string, unknown>,
  environment: PublicRuntimeEnvironment
): ResolvedRuntimeConfig {
  const buildProfile = optionalString(configuredExtra.buildProfile);
  const platform = optionalString(configuredExtra.buildPlatform);
  const buildPlatform: BuildPlatform | null =
    platform === 'android' || platform === 'ios' ? platform : null;
  const configuredApiUrl = optionalString(environment.apiBaseUrl) ||
    optionalString(configuredExtra.apiBaseUrl) || 'http://localhost:3000/api';
  const apiBaseUrl = buildProfile ? safeProfiledApiUrl(configuredApiUrl) : configuredApiUrl;
  const demoMode = booleanValue(
    environment.demoMode,
    configuredExtra.demoMode === true,
    'Scan demo mode'
  );
  if (buildProfile && demoMode) throw new Error('Scan demo mode must be disabled for profiled builds');
  if (buildProfile && !buildPlatform) {
    throw new Error('A profiled Scan runtime supports only an explicit android or ios platform; web is unsupported');
  }
  return { apiBaseUrl, buildProfile, buildPlatform, demoMode };
}

const runtimeConfig = resolveRuntimeConfig(Constants.expoConfig?.extra ?? {}, {
  apiBaseUrl: process.env.EXPO_PUBLIC_API_URL,
  demoMode: process.env.EXPO_PUBLIC_DEMO_MODE,
});

export const BUILD_PROFILE = runtimeConfig.buildProfile;
export const BUILD_PLATFORM = runtimeConfig.buildPlatform;
export const API_BASE_URL = runtimeConfig.apiBaseUrl;
export const DEMO_MODE = runtimeConfig.demoMode;

export const SYNC_STALE_WARNING_MS = 60 * 1000;
export const SCAN_UPLOAD_BATCH_SIZE = 25;
export const SCAN_UPLOAD_MAX_BATCHES_PER_SYNC = 4;
export const AUXILIARY_UPLOAD_BATCH_SIZE = 10;
export const AUXILIARY_UPLOAD_MAX_BATCHES_PER_SYNC = 2;
