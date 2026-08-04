import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { API_BASE_URL } from '../config';

const ACCESS_TOKEN_KEY = 'verigate_scan_access_token';
const REFRESH_TOKEN_KEY = 'verigate_scan_refresh_token';
const TOKEN_BINDING_KEY = 'verigate_scan_token_binding';
const SESSION_KIND_KEY = 'verigate_scan_session_kind';
const DEVICE_EVENT_ID_KEY = 'verigate_scan_device_event_id';
const TRANSITION_AUDITS_KEY = 'verigate_scan_transition_audits';
const LOGIN_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 15_000;
const AUDIT_UPLOAD_TIMEOUT_MS = 20_000;
const HEARTBEAT_TIMEOUT_MS = 5_000;

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
  request_id?: string;
  correlation_id?: string;
}

export interface ApiTrace {
  requestId?: string;
  correlationId: string;
}

const SAFE_TRACE_ID = /^[A-Za-z0-9._:-]{1,64}$/;

function safeTraceId(value: unknown): string | undefined {
  return typeof value === 'string' && SAFE_TRACE_ID.test(value) ? value : undefined;
}

function traceForResponse<T>(
  response: Awaited<ReturnType<typeof fetch>>,
  json: APIResponse<T>,
  sentCorrelationId: string
): ApiTrace {
  return {
    requestId: safeTraceId(response.headers?.get?.('x-request-id'))
      ?? safeTraceId(json.request_id),
    correlationId: safeTraceId(response.headers?.get?.('x-correlation-id'))
      ?? safeTraceId(json.correlation_id)
      ?? sentCorrelationId,
  };
}

type SessionKind = 'account' | 'device';
export type ApiFailureKind = 'timeout' | 'network' | 'session' | 'validation' | 'server';

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

export interface TransitionAuditCredential {
  event_id: number;
  cutoff: string;
  expires_at: string;
  auditToken: string;
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
    public readonly code?: string,
    public readonly kind: ApiFailureKind = statusCode === 401 || statusCode === 403
      ? 'session'
      : statusCode >= 400 && statusCode < 500
        ? 'validation'
        : 'server',
    public readonly requestId?: string,
    public readonly correlationId?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function fetchJsonWithDeadline<T>(
  url: string,
  init: Record<string, unknown>,
  timeoutMs: number,
  correlationId: string
): Promise<{ response: Awaited<ReturnType<typeof fetch>>; json: T }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const operation = (async () => {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const json = await response.json() as T;
    return { response, json };
  })();
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ApiError(
        0, 'Request timed out', undefined, 'REQUEST_TIMEOUT', 'timeout', undefined, correlationId
      ));
    }, Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      0,
      error instanceof Error ? error.message : 'Network request failed',
      undefined,
      'NETWORK_ERROR',
      'network',
      undefined,
      correlationId
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class ApiClientClass {
  private accessToken: string | null = null;
  private refreshToken: string | null = null;
  private tokenBinding: string | null = null;
  private sessionKind: SessionKind | null = null;
  private deviceEventId: number | null = null;
  private lastTrace: ApiTrace | null = null;

  async loadTokens(): Promise<void> {
    const [accessToken, refreshToken, tokenBinding, sessionKind, deviceEventId] = await Promise.all([
      SecureStore.getItemAsync(ACCESS_TOKEN_KEY),
      SecureStore.getItemAsync(REFRESH_TOKEN_KEY),
      SecureStore.getItemAsync(TOKEN_BINDING_KEY),
      SecureStore.getItemAsync(SESSION_KIND_KEY),
      SecureStore.getItemAsync(DEVICE_EVENT_ID_KEY),
    ]);
    this.accessToken = accessToken;
    this.refreshToken = refreshToken;
    this.tokenBinding = tokenBinding;
    this.sessionKind = sessionKind === 'account' || sessionKind === 'device'
      ? sessionKind
      : null;
    const parsedEventId = Number(deviceEventId);
    this.deviceEventId = Number.isSafeInteger(parsedEventId) && parsedEventId > 0
      ? parsedEventId
      : null;
  }

  isAuthenticated(): boolean {
    return !!this.accessToken;
  }

  getTokenBinding(): string | null {
    return this.tokenBinding;
  }

  getDeviceEventId(): number | null {
    return this.sessionKind === 'device' ? this.deviceEventId : null;
  }

  getLastRequestTrace(): ApiTrace | null {
    return this.lastTrace ? { ...this.lastTrace } : null;
  }

  private captureTrace<T>(
    response: Awaited<ReturnType<typeof fetch>>,
    json: APIResponse<T>,
    correlationId: string
  ): ApiTrace {
    const trace = traceForResponse(response, json, correlationId);
    this.lastTrace = trace;
    return trace;
  }

  hasDeviceSession(): boolean {
    return !!this.accessToken && this.sessionKind === 'device';
  }

  hasAccountSession(): boolean {
    return !!this.accessToken && this.sessionKind === 'account';
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
    this.deviceEventId = null;
    this.lastTrace = null;
    await Promise.all([
      SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY),
      SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY),
      SecureStore.deleteItemAsync(TOKEN_BINDING_KEY),
      SecureStore.deleteItemAsync(SESSION_KIND_KEY),
      SecureStore.deleteItemAsync(DEVICE_EVENT_ID_KEY),
    ]);
  }

  async logout(): Promise<void> {
    try {
      if (this.accessToken) {
        const correlationId = Crypto.randomUUID();
        await fetchJsonWithDeadline(`${API_BASE_URL}/auth/logout`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.accessToken}`,
            'X-Correlation-Id': correlationId,
          },
        }, HEARTBEAT_TIMEOUT_MS, correlationId).catch(() => undefined);
      }
    } finally {
      await this.clearTokens();
    }
  }

  async login(email: string, password: string): Promise<BackendUser> {
    const correlationId = Crypto.randomUUID();
    const { response: res, json } = await fetchJsonWithDeadline<
      APIResponse<{ user: BackendUser; accessToken: string; refreshToken: string }>
    >(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Correlation-Id': correlationId,
      },
      body: JSON.stringify({ email, password, client_kind: 'scan' }),
    }, LOGIN_TIMEOUT_MS, correlationId);
    const trace = this.captureTrace(res, json, correlationId);
    if (!res.ok || !json.success || !json.data) {
      throw new ApiError(
        res.status,
        json.error || 'Login failed',
        undefined,
        json.code,
        undefined,
        trace.requestId,
        trace.correlationId
      );
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
      transition_audits?: TransitionAuditCredential[];
    }>('/devices/session', {
      method: 'POST',
      timeoutMs: LOGIN_TIMEOUT_MS,
      idempotencyKey: `${installationId}:scan:${eventId}`,
      body: {
        event_id: eventId,
        app: 'scan',
        installation_id: installationId,
        platform,
      },
    });
    if (data.registration.event_id !== eventId || data.registration.app !== 'scan') {
      throw new ApiError(
        409,
        'Registered device session does not match the selected event',
        undefined,
        'DEVICE_EVENT_BINDING_MISMATCH'
      );
    }
    await this.setTokens(data.accessToken, data.refreshToken, { kind: 'device' });
    this.deviceEventId = data.registration.event_id;
    await Promise.all([
      SecureStore.setItemAsync(DEVICE_EVENT_ID_KEY, String(data.registration.event_id)),
      data.transition_audits?.length
        ? SecureStore.setItemAsync(TRANSITION_AUDITS_KEY, JSON.stringify(data.transition_audits))
        : Promise.resolve(),
    ]);
    return data.registration;
  }

  async getTransitionAuditCredentials(): Promise<TransitionAuditCredential[]> {
    const encoded = await SecureStore.getItemAsync(TRANSITION_AUDITS_KEY);
    if (!encoded) return [];
    try {
      const values = JSON.parse(encoded) as TransitionAuditCredential[];
      return values.filter((value) =>
        Number.isSafeInteger(value.event_id) &&
        value.event_id > 0 &&
        Number.isFinite(Date.parse(value.cutoff)) &&
        Number.isFinite(Date.parse(value.expires_at)) &&
        typeof value.auditToken === 'string' &&
        value.auditToken.length > 0
      );
    } catch {
      return [];
    }
  }

  async removeTransitionAuditCredential(eventId: number): Promise<void> {
    const remaining = (await this.getTransitionAuditCredentials())
      .filter((credential) => credential.event_id !== eventId);
    if (remaining.length === 0) {
      await SecureStore.deleteItemAsync(TRANSITION_AUDITS_KEY);
    } else {
      await SecureStore.setItemAsync(TRANSITION_AUDITS_KEY, JSON.stringify(remaining));
    }
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

  private async refresh(deadlineAt: number, correlationId: string): Promise<boolean> {
    if (!this.refreshToken) return false;
    try {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        throw new ApiError(
          0, 'Session refresh timed out', undefined, 'REQUEST_TIMEOUT', 'timeout', undefined,
          correlationId
        );
      }
      const { response: res, json } = await fetchJsonWithDeadline<
        APIResponse<{ accessToken: string; refreshToken: string }>
      >(`${API_BASE_URL}/auth/refresh`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Correlation-Id': correlationId,
        },
        body: JSON.stringify({ refreshToken: this.refreshToken }),
      }, remaining, correlationId);
      const trace = this.captureTrace(res, json, correlationId);
      if (!res.ok || !json.success || !json.data) {
        throw new ApiError(
          res.status, json.error || 'Session refresh failed', undefined, json.code, undefined,
          trace.requestId, trace.correlationId
        );
      }
      await this.setTokens(json.data.accessToken, json.data.refreshToken);
      return true;
    } catch (error) {
      throw error;
    }
  }

  async request<T>(path: string, options: {
    method?: string;
    body?: unknown;
    params?: Record<string, string | number>;
    timeoutMs?: number;
    idempotencyKey?: string;
  } = {}): Promise<T> {
    if (!this.accessToken) throw new Error('Not authenticated');

    const query = options.params
      ? '?' + new URLSearchParams(Object.entries(options.params).map(([k, v]) => [k, String(v)])).toString()
      : '';
    const url = `${API_BASE_URL}${path}${query}`;
    const correlationId = Crypto.randomUUID();

    const deadlineAt = Date.now() + (options.timeoutMs ?? REQUEST_TIMEOUT_MS);
    const doFetch = async () => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        throw new ApiError(
          0, `Request timed out: ${path}`, undefined, 'REQUEST_TIMEOUT', 'timeout', undefined,
          correlationId
        );
      }
      return fetchJsonWithDeadline<APIResponse<T>>(url, {
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
          'X-Correlation-Id': correlationId,
          ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
        },
        body: options.body ? JSON.stringify(options.body) : undefined,
      }, remaining, correlationId);
    };

    let { response: res, json } = await doFetch();
    let trace = this.captureTrace(res, json, correlationId);
    if (res.status === 401) {
      const initialError = new ApiError(
        res.status,
        json.error || `Request failed: ${path}`,
        safeErrorData(json.data),
        json.code,
        undefined,
        trace.requestId,
        trace.correlationId
      );
      try {
        const refreshed = await this.refresh(deadlineAt, correlationId);
        if (refreshed) {
          ({ response: res, json } = await doFetch());
          trace = this.captureTrace(res, json, correlationId);
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
        json.code,
        undefined,
        trace.requestId,
        trace.correlationId
      );
    }
    return json.data as T;
  }

  async auditRequest<T>(
    accessToken: string,
    path: string,
    options: { method?: string; body?: unknown } = {}
  ): Promise<T> {
    const correlationId = Crypto.randomUUID();
    const { response, json } = await fetchJsonWithDeadline<APIResponse<T>>(
      `${API_BASE_URL}${path}`,
      {
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        'X-Correlation-Id': correlationId,
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      },
      AUDIT_UPLOAD_TIMEOUT_MS,
      correlationId
    );
    const trace = this.captureTrace(response, json, correlationId);
    if (!response.ok || !json.success) {
      throw new ApiError(
        response.status,
        json.error || `Audit request failed: ${path}`,
        safeErrorData(json.data),
        json.code,
        undefined,
        trace.requestId,
        trace.correlationId
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
