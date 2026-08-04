type RuntimeConfig = typeof import('./config');

const ORIGINAL_ENV = { ...process.env };

function loadConfig(extra: Record<string, unknown>, environment: Record<string, string | undefined> = {}): RuntimeConfig {
  jest.resetModules();
  process.env = { ...ORIGINAL_ENV };
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  jest.doMock('expo-constants', () => ({ __esModule: true, default: { expoConfig: { extra } } }));
  return jest.requireActual<RuntimeConfig>('./config');
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.resetModules();
  jest.clearAllMocks();
});

describe('Scan runtime configuration', () => {
  it('allows loopback only for an unprofiled local runtime', () => {
    const config = loadConfig({ apiBaseUrl: 'http://localhost:3000/api', demoMode: false });
    expect(config.API_BASE_URL).toBe('http://localhost:3000/api');
    expect(config.BUILD_PROFILE).toBeNull();
  });

  it('accepts a safe profiled Android or iOS runtime', () => {
    for (const buildPlatform of ['android', 'ios']) {
      const config = loadConfig({
        apiBaseUrl: 'https://verigate-api.example.com/api',
        demoMode: false,
        buildProfile: 'production',
        buildPlatform,
      });
      expect(config.API_BASE_URL).toBe('https://verigate-api.example.com/api');
      expect(config.BUILD_PLATFORM).toBe(buildPlatform);
    }
  });

  it('rejects unsafe overrides and unsupported profiled web runtime', () => {
    const extra = {
      apiBaseUrl: 'https://verigate-api.example.com/api',
      demoMode: false,
      buildProfile: 'production',
      buildPlatform: 'android',
    };
    const config = loadConfig(extra);
    expect(() => config.resolveRuntimeConfig(extra, { apiBaseUrl: 'http://localhost:3000/api' }))
      .toThrow(/API URL/i);
    expect(() => config.resolveRuntimeConfig({ ...extra, buildPlatform: 'web' }, {}))
      .toThrow(/web is unsupported/i);
  });
});
