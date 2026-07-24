/* eslint-disable import/first */
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(async () => undefined),
}));
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }));

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import {
  DeviceIdentityServiceClass,
  legacyQueueRecordId,
} from '../DeviceIdentityService';

describe('Scan installation identity', () => {
  beforeEach(() => jest.clearAllMocks());

  it('gives two installations with local row id 1 different stable queue ids', async () => {
    const firstStore = new Map<string, string>();
    jest.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => firstStore.get(key) ?? null);
    jest.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      firstStore.set(key, value);
    });
    jest.mocked(Crypto.randomUUID).mockReturnValueOnce('installation-a');
    const first = new DeviceIdentityServiceClass();
    const firstIdentity = await first.getInstallationId();
    const firstRecord = legacyQueueRecordId('incident', firstIdentity, 1);
    expect(await new DeviceIdentityServiceClass().getInstallationId()).toBe(firstIdentity);

    const secondStore = new Map<string, string>();
    jest.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => secondStore.get(key) ?? null);
    jest.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      secondStore.set(key, value);
    });
    jest.mocked(Crypto.randomUUID).mockReturnValueOnce('installation-b');
    const secondIdentity = await new DeviceIdentityServiceClass().getInstallationId();
    const secondRecord = legacyQueueRecordId('incident', secondIdentity, 1);

    expect(firstRecord).not.toBe(secondRecord);
    expect(firstRecord).toBe('legacy-incident-scan-installation-a-1');
    expect(secondRecord).toBe('legacy-incident-scan-installation-b-1');
  });

  it('adopts and persists the previous fallback identity', async () => {
    jest.mocked(SecureStore.getItemAsync).mockImplementation(async (key) =>
      key === 'verigate_scan_fallback_device_id' ? 'scan-existing' : null
    );

    await expect(new DeviceIdentityServiceClass().getInstallationId()).resolves.toBe('scan-existing');
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      'verigate_scan_installation_id',
      'scan-existing'
    );
    expect(Crypto.randomUUID).not.toHaveBeenCalled();
  });
});
