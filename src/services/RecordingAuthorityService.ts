import type { User } from './DatabaseService';
import { QR_TRUST_HARD_AGE_MS, QR_TRUST_SOFT_AGE_MS } from './QrCredentialService';

export interface EventRecordingAuthority {
  id: number;
  name: string;
  is_active: boolean;
  starts_at: string | null;
  ends_at: string | null;
}

export interface RecordingAuthorityInput {
  databaseReady: boolean;
  appState: 'active' | 'background' | 'inactive' | 'unknown' | 'extension';
  blockingModal: boolean;
  operationInFlight: boolean;
  deviceSession: boolean;
  revoked: boolean;
  event: EventRecordingAuthority | null;
  selectedArea: { id: number; name: string } | null;
  lastSyncAt: number | null;
  now?: number;
  demoMode?: boolean;
  auditHealthy?: boolean;
}

export type RecordingAuthorityCode =
  | 'ready'
  | 'database-unavailable'
  | 'app-inactive'
  | 'modal-open'
  | 'operation-in-flight'
  | 'device-session-required'
  | 'device-revoked'
  | 'event-required'
  | 'event-inactive'
  | 'event-upcoming'
  | 'event-ended'
  | 'event-time-invalid'
  | 'area-required'
  | 'audit-degraded'
  | 'authority-expired';

export type RecordingAuthorityDecision =
  | { allowed: true; code: 'ready' }
  | { allowed: false; code: Exclude<RecordingAuthorityCode, 'ready'>; message: string };

export type RecordingFreshness = 'never' | 'current' | 'online-required' | 'expired';

export function recordingFreshness(lastSyncAt: number | null, now = Date.now()): RecordingFreshness {
  if (lastSyncAt == null || !Number.isFinite(lastSyncAt)) return 'never';
  const age = Math.max(0, now - lastSyncAt);
  if (age <= QR_TRUST_SOFT_AGE_MS) return 'current';
  if (age <= QR_TRUST_HARD_AGE_MS) return 'online-required';
  return 'expired';
}

function denied(code: Exclude<RecordingAuthorityCode, 'ready'>, message: string): RecordingAuthorityDecision {
  return { allowed: false, code, message };
}

export function evaluateRecordingAuthority(input: RecordingAuthorityInput): RecordingAuthorityDecision {
  const now = input.now ?? Date.now();
  if (!input.databaseReady) return denied('database-unavailable', 'Secure scanner storage is unavailable.');
  if (input.appState !== 'active') return denied('app-inactive', 'Return to the foreground before recording.');
  if (input.blockingModal) return denied('modal-open', 'Close the current dialog before scanning.');
  if (input.operationInFlight) return denied('operation-in-flight', 'Wait for the current record to finish.');
  if (!input.demoMode && !input.deviceSession) return denied('device-session-required', 'A current device session is required.');
  if (input.revoked) return denied('device-revoked', 'This installation is no longer authorized to record.');
  if (!input.event) return denied('event-required', 'Select and synchronize an event first.');
  if (!input.event.is_active) return denied('event-inactive', 'The selected event is inactive.');

  const startsAt = input.event.starts_at == null ? null : Date.parse(input.event.starts_at);
  const endsAt = input.event.ends_at == null ? null : Date.parse(input.event.ends_at);
  if ((startsAt != null && !Number.isFinite(startsAt)) || (endsAt != null && !Number.isFinite(endsAt))) {
    return denied('event-time-invalid', 'The selected event has invalid time authority.');
  }
  if (startsAt != null && now < startsAt) return denied('event-upcoming', 'The selected event has not started.');
  if (endsAt != null && now > endsAt) return denied('event-ended', 'The selected event has ended.');
  if (!input.selectedArea) return denied('area-required', 'Choose a current event area before recording.');
  if (input.auditHealthy === false) {
    return denied('audit-degraded', 'Local audit storage needs recovery before recording can continue.');
  }
  if (!input.demoMode && recordingFreshness(input.lastSyncAt, now) === 'expired') {
    return denied('authority-expired', 'Authorization data has expired. Reconnect and synchronize.');
  }
  return { allowed: true, code: 'ready' };
}

export type ManualAssignmentDecision =
  | { granted: true; code: 'manual_access_granted' }
  | {
      granted: false;
      code: 'manual_subject_inactive' | 'manual_event_mismatch' | 'manual_assignment_missing';
      reason: string;
    };

export function evaluateManualAssignment(
  user: User,
  eventId: number,
  areaId: number,
  now = Date.now()
): ManualAssignmentDecision {
  if (!user.is_active) {
    return { granted: false, code: 'manual_subject_inactive', reason: 'Attendee is inactive.' };
  }
  if (user.event_id !== eventId) {
    return { granted: false, code: 'manual_event_mismatch', reason: 'Attendee belongs to another event.' };
  }
  const assignment = (user.assignments ?? []).find((candidate) => {
    const from = Date.parse(candidate.valid_from);
    const until = Date.parse(candidate.valid_until);
    return candidate.area_id === areaId && Number.isFinite(from) && Number.isFinite(until) && from <= now && until >= now;
  });
  if (!assignment) {
    return {
      granted: false,
      code: 'manual_assignment_missing',
      reason: 'No current assignment authorizes this area.',
    };
  }
  return { granted: true, code: 'manual_access_granted' };
}

export interface DurableDecisionPresentation {
  success: boolean;
  message: string;
  userName?: string;
}

export function durableDecisionAfterLocalFailure(
  decision: DurableDecisionPresentation,
  _error: unknown
): DurableDecisionPresentation & { auditDegraded: true } {
  return {
    ...decision,
    message: `${decision.message}. Local audit storage needs recovery; scanning is paused.`,
    auditDegraded: true,
  };
}
