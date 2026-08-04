/* eslint-disable import/first */
jest.mock('expo-router', () => ({ router: { replace: jest.fn() } }));
jest.mock('@/services/ApiClient', () => ({ ApiClient: {} }));
jest.mock('@/services/DatabaseService', () => ({ DatabaseService: {} }));
jest.mock('@/services/DeviceControlService', () => ({ DeviceControlService: {} }));
jest.mock('@/services/OfflineSessionService', () => ({ OfflineSessionService: {} }));
jest.mock('@/services/SyncService', () => ({ SyncService: {} }));

import { classifyEligibleEvent, eligibleEvents } from '../select-event';

const base = {
  id: 7,
  name: 'Operations',
  starts_at: null,
  ends_at: null,
  is_active: true,
  role_in_event: 'scanner',
};

describe('Scan event eligibility', () => {
  const now = Date.parse('2026-08-04T12:00:00.000Z');

  it('accepts only active scanner/admin memberships inside the event window', () => {
    expect(classifyEligibleEvent(base, now)).toBe('eligible');
    expect(classifyEligibleEvent({ ...base, role_in_event: 'admin' }, now)).toBe('eligible');
    expect(classifyEligibleEvent({ ...base, role_in_event: 'attendee' }, now)).toBe('role-ineligible');
    expect(classifyEligibleEvent({ ...base, is_active: false }, now)).toBe('inactive');
    expect(classifyEligibleEvent({ ...base, starts_at: '2026-08-04T13:00:00.000Z' }, now)).toBe('upcoming');
    expect(classifyEligibleEvent({ ...base, ends_at: '2026-08-04T11:00:00.000Z' }, now)).toBe('ended');
  });

  it('never selects the first server row implicitly', () => {
    const events = [
      { ...base, id: 1, is_active: false },
      { ...base, id: 2, name: 'Current' },
      { ...base, id: 3, role_in_event: 'attendee' },
    ];
    expect(eligibleEvents(events, now)).toEqual([{ ...base, id: 2, name: 'Current' }]);
  });
});
