/* eslint-disable import/first */
jest.mock('expo-router', () => ({ router: { back: jest.fn() } }));
jest.mock('@/services/DatabaseService', () => ({ DatabaseService: {} }));
jest.mock('@/services/DeregistrationAuditService', () => ({ DeregistrationAuditService: {} }));
jest.mock('@/services/ApiClient', () => ({ ApiClient: {} }));
jest.mock('@/services/SyncScheduler', () => ({ SyncScheduler: {} }));
jest.mock('@/services/SyncService', () => ({ SyncService: {} }));

import { queueHealthSummary } from '../queue-status';

describe('queue health presentation', () => {
  it('summarizes only event-scoped state counts', () => {
    expect(queueHealthSummary({
      pending: 2,
      retrying: 1,
      terminal: 3,
      quarantined: 4,
      acknowledged: 9,
      unresolved: 10,
    })).toBe('10 unresolved: 2 pending, 1 retrying, 3 terminal, 4 quarantined');
  });
});
