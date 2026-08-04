/* eslint-disable import/first */
jest.mock('../DatabaseService', () => ({
  DatabaseService: { performStorageMaintenance: jest.fn() },
}));
jest.mock('../SyncService', () => ({
  SyncService: { getCurrentEventId: jest.fn() },
}));

import { StorageMaintenanceServiceClass } from '../StorageMaintenanceService';

describe('StorageMaintenanceService', () => {
  it('coalesces concurrent bounded maintenance and passes the selected event', async () => {
    let release!: () => void;
    const maintain = jest.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const service = new StorageMaintenanceServiceClass({
      currentEventId: async () => 7,
      maintain,
      now: () => Date.parse('2026-08-04T12:00:00.000Z'),
    });

    const first = service.run();
    const second = service.run();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(maintain).toHaveBeenCalledWith({
      activeEventId: 7,
      now: Date.parse('2026-08-04T12:00:00.000Z'),
    });
    release();
    await first;
  });
});
