/* eslint-disable import/first */
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
jest.mock('../DatabaseService', () => ({ DatabaseService: {} }));
jest.mock('../SyncService', () => ({ SyncService: {} }));

import {
  DeregistrationAuditServiceClass,
  DeregistrationAuditStore,
} from '../DeregistrationAuditService';

function storeDouble(): DeregistrationAuditStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: jest.fn(async (key) => values.get(key) ?? null),
    setItem: jest.fn(async (key, value) => { values.set(key, value); }),
    deleteItem: jest.fn(async (key) => { values.delete(key); }),
  };
}

describe('DeregistrationAuditService', () => {
  const session = {
    eventId: 7,
    cutoff: '2026-08-04T12:00:00.000Z',
    deadline: '2026-08-04T13:00:00.000Z',
    accessToken: 'audit-token',
  };

  it('persists before draining and resumes multiple batches after a new service instance', async () => {
    const store = storeDouble();
    const drain = jest.fn()
      .mockResolvedValueOnce({ uploaded: 25 })
      .mockResolvedValueOnce({ uploaded: 5 });
    const health = jest.fn()
      .mockResolvedValueOnce({ unresolved: 30 })
      .mockResolvedValueOnce({ unresolved: 5 })
      .mockResolvedValueOnce({ unresolved: 0 });
    const quarantine = jest.fn();
    const first = new DeregistrationAuditServiceClass({
      store,
      drain,
      health,
      quarantine,
      now: () => Date.parse('2026-08-04T12:10:00.000Z'),
    });
    await first.begin(session);
    expect(store.setItem).toHaveBeenCalledTimes(1);
    expect(drain).not.toHaveBeenCalled();

    const restarted = new DeregistrationAuditServiceClass({
      store,
      drain,
      health,
      quarantine,
      now: () => Date.parse('2026-08-04T12:10:00.000Z'),
    });
    await expect(restarted.resume({ maximumPasses: 5, foregroundBudgetMs: 5_000 }))
      .resolves.toEqual({ status: 'completed', uploaded: 30, unresolved: 0 });
    expect(drain).toHaveBeenCalledTimes(2);
    expect(store.values.size).toBe(0);
  });

  it('quarantines unresolved records at expiry and never drains after blacklist', async () => {
    const store = storeDouble();
    const drain = jest.fn();
    const health = jest.fn(async () => ({ unresolved: 3 }));
    const quarantine = jest.fn(async () => undefined);
    const service = new DeregistrationAuditServiceClass({
      store,
      drain,
      health,
      quarantine,
      now: () => Date.parse('2026-08-04T13:00:00.001Z'),
    });
    await service.begin(session);
    await expect(service.resume()).resolves.toEqual({ status: 'expired', uploaded: 0, unresolved: 3 });
    expect(quarantine).toHaveBeenCalledWith(7, expect.stringMatching(/expired/i));
    expect(drain).not.toHaveBeenCalled();

    await service.begin(session);
    await service.cancelForBlacklist();
    expect(quarantine).toHaveBeenLastCalledWith(7, expect.stringMatching(/blacklist/i));
    expect(drain).not.toHaveBeenCalled();
    expect(store.values.size).toBe(0);
  });
});
