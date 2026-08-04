/* eslint-disable import/first */
jest.mock('../ApiClient', () => ({ ApiClient: { clearTokens: jest.fn() } }));
jest.mock('../DatabaseService', () => ({
  DatabaseService: {
    clearScannerCredentials: jest.fn(),
    resetForReprovisioning: jest.fn(),
  },
}));
jest.mock('../DeviceIdentityService', () => ({
  DeviceIdentityService: { resetInstallationId: jest.fn() },
}));
jest.mock('../OfflineSessionService', () => ({
  OfflineSessionService: { clear: jest.fn() },
}));
jest.mock('../SyncService', () => ({
  SyncService: { clearEventSelection: jest.fn() },
}));

import {
  evaluateProvisioningReset,
  ProvisioningResetServiceClass,
} from '../ProvisioningResetService';

describe('provisioning reset policy', () => {
  const safe = {
    deviceState: 'deregistered' as const,
    unresolvedRecords: 0,
    confirmation: 'RESET SCANNER',
  };

  it('requires deregistration, closed queues, and exact typed confirmation', () => {
    expect(evaluateProvisioningReset(safe)).toEqual({ allowed: true });
    expect(evaluateProvisioningReset({ ...safe, deviceState: 'active' })).toMatchObject({ allowed: false });
    expect(evaluateProvisioningReset({ ...safe, unresolvedRecords: 1 })).toMatchObject({ allowed: false });
    expect(evaluateProvisioningReset({ ...safe, confirmation: 'reset scanner' })).toMatchObject({ allowed: false });
  });

  it('coalesces concurrent reset requests into one destructive operation', async () => {
    let release!: () => void;
    const reset = jest.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const service = new ProvisioningResetServiceClass(reset);

    const first = service.reset(safe);
    const second = service.reset(safe);
    expect(first).toBe(second);
    expect(reset).toHaveBeenCalledTimes(1);

    release();
    await first;
  });
});
