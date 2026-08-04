import type { ApiTrace, BackendUser } from '../src/services/ApiClient';

export const SCAN_NATIVE_ADAPTER_SUBSTITUTIONS = Object.freeze([
  'camera-transport',
  'sqlcipher-binding',
  'secure-store',
  'device-biometrics',
  'os-connectivity',
  'audio-feedback',
  'push-notifications',
]);

export interface ScanProductionClient {
  login(email: string, password: string): Promise<BackendUser>;
  request<T>(path: string, options?: {
    method?: string;
    body?: unknown;
    params?: Record<string, string | number>;
    timeoutMs?: number;
    idempotencyKey?: string;
  }): Promise<T>;
  auditRequest<T>(accessToken: string, path: string, options?: {
    method?: string;
    body?: unknown;
  }): Promise<T>;
  getLastRequestTrace(): ApiTrace | null;
}

export function createScanCompatibilityDriver(client: ScanProductionClient) {
  return Object.freeze({
    nativeAdapterSubstitutions: SCAN_NATIVE_ADAPTER_SUBSTITUTIONS,
    login: (email: string, password: string) => client.login(email, password),
    request: <T>(path: string, options?: Parameters<ScanProductionClient['request']>[1]) =>
      client.request<T>(path, options),
    auditRequest: <T>(token: string, path: string, options?: Parameters<ScanProductionClient['auditRequest']>[2]) =>
      client.auditRequest<T>(token, path, options),
    trace: () => client.getLastRequestTrace(),
  });
}
