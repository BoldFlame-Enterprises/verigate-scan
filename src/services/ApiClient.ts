import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { API_BASE_URL } from '../config';

const ACCESS_TOKEN_KEY = 'verigate_scan_access_token';
const REFRESH_TOKEN_KEY = 'verigate_scan_refresh_token';
const TOKEN_BINDING_KEY = 'verigate_scan_token_binding';

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
    public readonly responseData?: SafeApiErrorData
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

class ApiClientClass {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenBinding: string | null = null;

  async loadTokens(): Promise<void> {
    [this.accessToken, this.refreshToken, this.tokenBinding] = await Promise.all([
      SecureStore.getItemAsync(ACCESS_TOKEN_KEY),
      SecureStore.getItemAsync(REFRESH_TOKEN_KEY),
      SecureStore.getItemAsync(TOKEN_BINDING_KEY),
    ]);
  }

  isAuthenticated(): boolean {
    return !!this.accessToken;
  }

  getTokenBinding(): string | null {
    return this.tokenBinding;
  }

  private async setTokens(accessToken: string, refreshToken: string, rotateBinding = false): Promise<void> {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    if (rotateBinding || !this.tokenBinding) {
      this.tokenBinding = Crypto.randomUUID();
    }
    await Promise.all([
      SecureStore.setItemAsync(ACCESS_TOKEN_KEY, accessToken),
      SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken),
      SecureStore.setItemAsync(TOKEN_BINDING_KEY, this.tokenBinding),
    ]);
  }

  async clearTokens(): Promise<void> {
    this.accessToken = null;
    this.refreshToken = null;
    this.tokenBinding = null;
    await Promise.all([
      SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY),
      SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
      SecureStore.deleteItemAsync(TOKEN_BINDING_KEY),
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
    await this.setTokens(json.data.accessToken, json.data.refreshToken, true);
    return json.data.user;
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
      if (!res.ok || !json.success || !json.data) return false;
      await this.setTokens(json.data.accessToken, json.data.refreshToken);
      return true;
    } catch {
      return false;
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
    if (res.status === 401) {
      const refreshed = await this.refresh();
      if (refreshed) {
        res = await doFetch();
      }
    }

    const json: APIResponse<T> = await res.json();
    if (!res.ok || !json.success) {
      throw new ApiError(
        res.status,
        json.error || `Request failed: ${path}`,
        safeErrorData(json.data)
      );
    }
    return json.data as T;
  }
}

export const ApiClient = new ApiClientClass();
