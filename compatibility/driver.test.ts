import {
  createScanCompatibilityDriver,
  SCAN_NATIVE_ADAPTER_SUBSTITUTIONS,
  ScanProductionClient,
} from './driver';

describe('Scan compatibility driver', () => {
  it('delegates to production request contracts and declares native boundaries', async () => {
    const request = jest.fn(async () => ({ ok: true }));
    const auditRequest = jest.fn(async () => ({ accepted: true }));
    const client: ScanProductionClient = {
      login: jest.fn(async () => ({ id: 2 } as never)),
      request: request as ScanProductionClient['request'],
      auditRequest: auditRequest as ScanProductionClient['auditRequest'],
      getLastRequestTrace: jest.fn(() => ({ correlationId: 'operation-2', requestId: 'request-2' })),
    };
    const driver = createScanCompatibilityDriver(client);

    await driver.login('scan@example.test', 'not-recorded');
    await driver.request('/events');
    await driver.auditRequest('ephemeral-test-value', '/scan-logs/batch');

    expect(request).toHaveBeenCalledWith('/events', undefined);
    expect(auditRequest).toHaveBeenCalledTimes(1);
    expect(driver.trace()).toEqual({ correlationId: 'operation-2', requestId: 'request-2' });
    expect(SCAN_NATIVE_ADAPTER_SUBSTITUTIONS).toContain('camera-transport');
  });
});
