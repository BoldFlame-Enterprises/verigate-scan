import * as SecureStore from 'expo-secure-store';
import { API_BASE_URL } from '../config';

const ACCESS_TOKEN_KEY = 'verigate_scan_access_token';
const REFRESH_TOKEN_KEY = 'verigate_scan_refresh_token';

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

class ApiClientClass {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;

  async loadTokens(): Promise<void> {
    this.accessToken = await SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
    this.refreshToken = await SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
  }

  isAuthenticated(): boolean {
    return !!this.accessToken;
  }

  private async setTokens(accessToken: string, refreshToken: string): Promise<void> {
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, accessToken);
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken);
  }

  async clearTokens(): Promise<void> {
    this.accessToken = null;
    this.refreshToken = null;
    await SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY);
    await SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY);
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
    await this.setTokens(json.data.accessToken, json.data.refreshToken);
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
      throw new Error(json.error || `Request failed: ${path}`);
    }
    return json.data as T;
  }
}

export const ApiClient = new ApiClientClass();
