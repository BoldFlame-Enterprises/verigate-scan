import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { API_BASE_URL } from '../config';

const ACCESS_TOKEN_KEY = 'verigate_scan_access_token';
const REFRESH_TOKEN_KEY = 'verigate_scan_refresh_token';
const TOKEN_BINDING_KEY = 'verigate_scan_token_binding';
const SESSION_KIND_KEY = 'verigate_scan_session_kind';

export interface BackendUser {
  id: number;
  email: string;
  name: string;
  phone: string;
  role: string;
  is_active: boolean;
}

interface APIResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  code?: string;
}

type SessionKind = 'account' | 'device';

export interface DeviceRegistration {
  id: number;
  event_id: number;
  app: 'scan';
  installation_id: string;
  state: 'active' | 'deregistered' | 'blacklisted';
  session_generation: number;
  version: number;
}

export interface AuditCredential {
  accessToken: string;
  expires_at: string;
  state_changed_at: string;
}

export interface SafeApiErrorData {
  contract_version?: string;
  client_record_id?: string;
  status?: string;
  error?: string;
}

function safeErrorData(value: unknown): SafeApiErrorData | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const safe: SafeApiErrorData = {};
  for (const key of ['contract_version', 'client_record_id', 'status', 'error'] as const) {
    if (typeof source[key] === 'string') safe[key] = source[key] as string;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly responseData?: SafeApiErrorData,
    public readonly code?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

class ApiClientClass {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenBinding: string | null = null;
  private sessionKind: SessionKind | null = null;

  async loadTokens(): Promise<void> {
    const [accessToken, refreshToken, tokenBinding, sessionKind] = await Promise.all([
      SecureStore.getItemAsync(ACCESS_TOKEN_KEY),
      SecureStore.getItemAsync(REFRESH_TOKEN_KEY),
      SecureStore.getItemAsync(TOKEN_BINDING_KEY),
      SecureStore.getItemAsync(SESSION_KIND_KEY),
    ]);
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.tokenBinding = tokenBinding;
    this.sessionKind = sessionKind === 'account' || sessionKind === 'device'
      ? sessionKind
      : null;
  }

  isAuthenticated(): boolean {
    return !!this.accessToken;
  }

  getTokenBinding(): string | null {
    return this.tokenBinding;
  }

  hasDeviceSession(): boolean {
    return !!this.accessToken && this.sessionKind === 'device';
  }

  private async setTokens(
    accessToken: string,
    refreshToken: string,
    options: { rotateBinding?: boolean; kind?: SessionKind } = {}
  ): Promise<void> {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    if (options.rotateBinding || !this.tokenBinding) {
      this.tokenBinding = Crypto.randomUUID();
    }
    if (options.kind) this.sessionKind = options.kind;
    await Promise.all([
      SecureStore.setItemAsync(ACCESS_TOKEN_KEY, accessToken),
      SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken),
      SecureStore.setItemAsync(TOKEN_BINDING_KEY, this.tokenBinding),
      SecureStore.setItemAsync(SESSION_KIND_KEY, this.sessionKind ?? 'account'),
    ]);
  }

  async clearTokens(): Promise<void> {
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenBinding = null;
    this.sessionKind = null;
    await Promise.all([
      SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY),
      SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
      SecureStore.deleteItemAsync(TOKEN_BINDING_KEY),
      SecureStore.deleteItemAsync(SESSION_KIND_KEY),
    ]);
  }

  async login(email: string, password: string): Promise<BackendUser> {
    const res = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const json: APIResponse<{ user: BackendUser; accessToken: string; refreshToken: string }> = await res.json();
    if (!res.ok || !json.success || !json.data) {
      throw new Error(json.error || 'Login failed');
    }
    await this.setTokens(json.data.accessToken, json.data.refreshToken, {
      rotateBinding: true,
      kind: 'account',
    });
    return json.data.user;
  }

  async registerDeviceSession(
    eventId: number,
    installationId: string,
    platform: 'android' | 'ios'
  ): Promise<DeviceRegistration> {
    const data = await this.request<{
      registration: DeviceRegistration;
      accessToken: string;
      refreshToken: string;
    }>('/devices/session', {
      method: 'POST',
      body: {
        event_id: eventId,
        app: 'scan',
        installation_id: installationId,
        platform,
      },
    });
    await this.setTokens(data.accessToken, data.refreshToken, { kind: 'device' });
    return data.registration;
  }

  async getDeviceState(): Promise<unknown> {
    return this.request('/devices/scan-state');
  }

  async obtainAuditCredential(): Promise<AuditCredential> {
    const credential = await this.request<{
      auditToken: string;
      expires_at: string;
      state_changed_at: string;
    }>('/devices/audit-credential', { method: 'POST' });
    return {
      accessToken: credential.auditToken,
      expires_at: credential.expires_at,
      state_changed_at: credential.state_changed_at,
    };
  }

  async clearAuditCredential(): Promise<void> {
    // Audit credentials are deliberately kept in memory by their caller only.
  }

  private async refresh(): Promise<boolean> {
    if (!this.refreshToken) return false;
    try {
      const res = await fetch(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.refreshToken }),
      });
      const json: APIResponse<{ accessToken: string; refreshToken: string }> = await res.json();
      if (!res.ok || !json.success || !json.data) {
        throw new ApiError(res.status, json.error || 'Session refresh failed', undefined, json.code);
      }
      await this.setTokens(json.data.accessToken, json.data.refreshToken);
      return true;
    } catch (error) {
      throw error;
    }
  }

  async request<T>(path: string, options: { method?: string; body?: unknown; params?: Record<string, string | number> } = {}): Promise<T> {
    if (!this.accessToken) throw new Error('Not authenticated');

    const query = options.params
      ? '?' + new URLSearchParams(Object.entries(options.params).map(([k, v]) => [k, String(v)])).toString()
      : '';
    const url = `${API_BASE_URL}${path}${query}`;

    const doFetch = async () =>
      fetch(url, {
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });

    let res = await doFetch();
    let json: APIResponse<T> = await res.json();
    if (res.status === 401) {
      const initialError = new ApiError(
        res.status,
        json.error || `Request failed: ${path}`,
        safeErrorData(json.data),
        json.code
      );
      try {
        const refreshed = await this.refresh();
        if (refreshed) {
          res = await doFetch();
          json = await res.json();
        }
      } catch (refreshError) {
        throw initialError.code ? initialError : refreshError;
      }
    }

    if (!res.ok || !json.success) {
      throw new ApiError(
        res.status,
        json.error || `Request failed: ${path}`,
        safeErrorData(json.data),
        json.code
      );
    }
    return json.data as T;
  }

  async auditRequest<T>(
    accessToken: string,
    path: string,
    options: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const json: APIResponse<T> = await response.json();
    if (!response.ok || !json.success) {
      throw new ApiError(
        response.status,
        json.error || `Audit request failed: ${path}`,
        safeErrorData(json.data),
        json.code
      );
    }
    return json.data as T;
  }
}

export type DeviceControlReason = 'deregistered' | 'blacklisted';

export function deviceControlReason(error: unknown): DeviceControlReason | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === 'DEVICE_BLACKLISTED') return 'blacklisted';
  if (
    error.code === 'DEVICE_DEREGISTERED'
    || error.code === 'DEVICE_SESSION_STALE'
    || error.code === 'DEVICE_SESSION_INVALID'
  ) return 'deregistered';
  return null;
}

export const ApiClient = new ApiClientClass();
