import {
  durableDecisionAfterLocalFailure,
  evaluateManualAssignment,
  evaluateRecordingAuthority,
  recordingFreshness,
} from '../RecordingAuthorityService';

const now = Date.parse('2026-08-04T12:00:00.000Z');
const base = {
  databaseReady: true,
  appState: 'active' as const,
  blockingModal: false,
  operationInFlight: false,
  deviceSession: true,
  revoked: false,
  event: {
    id: 7,
    name: 'Operations',
    is_active: true,
    starts_at: '2026-08-04T10:00:00.000Z',
    ends_at: '2026-08-04T14:00:00.000Z',
  },
  selectedArea: { id: 3, name: 'Gate A' },
  lastSyncAt: now - 30_000,
  now,
};

describe('RecordingAuthorityService', () => {
  it('allows recording only when every lifecycle and authority gate is current', () => {
    expect(evaluateRecordingAuthority(base)).toEqual({ allowed: true, code: 'ready' });
    expect(evaluateRecordingAuthority({ ...base, blockingModal: true })).toMatchObject({ allowed: false, code: 'modal-open' });
    expect(evaluateRecordingAuthority({ ...base, appState: 'background' })).toMatchObject({ allowed: false, code: 'app-inactive' });
    expect(evaluateRecordingAuthority({ ...base, selectedArea: null })).toMatchObject({ allowed: false, code: 'area-required' });
    expect(evaluateRecordingAuthority({ ...base, event: { ...base.event, ends_at: '2026-08-04T11:00:00.000Z' } })).toMatchObject({ allowed: false, code: 'event-ended' });
    expect(evaluateRecordingAuthority({ ...base, revoked: true })).toMatchObject({ allowed: false, code: 'device-revoked' });
  });

  it('uses the same sixty-second boundary for visible and decision freshness', () => {
    expect(recordingFreshness(now - 60_000, now)).toBe('current');
    expect(recordingFreshness(now - 60_001, now)).toBe('online-required');
    expect(recordingFreshness(now - 24 * 60 * 60 * 1000 - 1, now)).toBe('expired');
    expect(evaluateRecordingAuthority({ ...base, lastSyncAt: now - 24 * 60 * 60 * 1000 - 1 })).toMatchObject({ allowed: false, code: 'authority-expired' });
  });

  it('requires an active current assignment for manual entry', () => {
    const user = {
      id: 5,
      email: 'holder@example.test',
      name: 'Holder',
      phone: '',
      event_id: 7,
      access_level: 'General',
      allowed_areas: ['Gate A'],
      is_active: true,
      assignments: [{
        area_id: 3,
        area_name: 'Gate A',
        access_level_id: 2,
        access_level_name: 'General',
        access_priority: 1,
        valid_from: '2026-08-04T11:00:00.000Z',
        valid_until: '2026-08-04T13:00:00.000Z',
      }],
    };
    expect(evaluateManualAssignment(user, 7, 3, now)).toEqual({ granted: true, code: 'manual_access_granted' });
    expect(evaluateManualAssignment({ ...user, event_id: 8 }, 7, 3, now)).toMatchObject({ granted: false, code: 'manual_event_mismatch' });
    expect(evaluateManualAssignment({ ...user, assignments: [] }, 7, 3, now)).toMatchObject({ granted: false, code: 'manual_assignment_missing' });
  });

  it('preserves a durable server result when local audit persistence fails', () => {
    expect(durableDecisionAfterLocalFailure({
      success: true,
      message: 'Access GRANTED for Holder',
      userName: 'Holder',
    }, new Error('disk full'))).toEqual({
      success: true,
      message: 'Access GRANTED for Holder. Local audit storage needs recovery; scanning is paused.',
      userName: 'Holder',
      auditDegraded: true,
    });
  });
});
