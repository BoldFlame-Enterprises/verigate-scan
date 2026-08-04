/* eslint-disable import/first */
jest.mock('@/services/DatabaseService', () => ({ DatabaseService: {} }));
jest.mock('@/services/DeviceControlService', () => ({ DeviceControlService: {} }));
jest.mock('@/services/ProvisioningResetService', () => ({
  PROVISIONING_RESET_CONFIRMATION: 'RESET SCANNER',
  ProvisioningResetService: {},
}));
jest.mock('@/services/StorageMaintenanceService', () => ({ StorageMaintenanceService: {} }));

import { integritySummary } from '../storage-recovery';

describe('storage recovery presentation', () => {
  it('does not report unsupported cipher diagnostics as corruption', () => {
    expect(integritySummary({ quickCheck: 'ok', cipherCheck: 'unsupported' })).toMatch(/unavailable/i);
    expect(integritySummary({ quickCheck: 'ok', cipherCheck: 'ok' })).toMatch(/passed/i);
  });
});
