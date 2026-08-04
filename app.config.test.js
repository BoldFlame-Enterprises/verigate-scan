const configureApp = require('./app.config');
const appJson = require('./app.json');
const easJson = require('./eas.json');

function baseConfig() {
  return JSON.parse(JSON.stringify(appJson.expo));
}

function environment(overrides = {}) {
  return {
    VERIGATE_BUILD_PROFILE: 'production',
    VERIGATE_BUILD_PLATFORM: 'ios',
    EXPO_PUBLIC_API_URL: 'https://verigate-api.example.com/api',
    EXPO_PUBLIC_DEMO_MODE: 'false',
    ...overrides,
  };
}

describe('Scan Expo release configuration', () => {
  it('allows explicit loopback configuration only for unprofiled local development', () => {
    const resolved = configureApp.resolveConfig({ config: baseConfig(), environment: {} });
    expect(resolved.extra).toMatchObject({
      apiBaseUrl: 'http://localhost:3000/api',
      demoMode: false,
    });
    expect(resolved.extra.buildProfile).toBeUndefined();
  });

  it.each([
    '',
    'http://verigate-api.example.com/api',
    'https://localhost/api',
    'https://127.0.0.1/api',
    'https://verigate-api.example.com',
    'https://user:password@verigate-api.example.com/api',
    'https://verigate-api.example.com/api?debug=true',
    'https://verigate-api.example.com/api#debug',
  ])('rejects an unsafe profiled API URL: %s', (apiBaseUrl) => {
    expect(() => configureApp.resolveConfig({
      config: baseConfig(),
      environment: environment({ EXPO_PUBLIC_API_URL: apiBaseUrl }),
    })).toThrow(/API URL/i);
  });

  it('rejects demo mode and unsupported or missing platforms in profiled builds', () => {
    expect(() => configureApp.resolveConfig({
      config: baseConfig(),
      environment: environment({ EXPO_PUBLIC_DEMO_MODE: 'true' }),
    })).toThrow(/demo mode/i);
    for (const platform of [undefined, '', 'web']) {
      expect(() => configureApp.resolveConfig({
        config: baseConfig(),
        environment: environment({ VERIGATE_BUILD_PLATFORM: platform }),
      })).toThrow(/unsupported|platform/i);
    }
  });

  it.each(['development', 'preview', 'production'])(
    'resolves platform-neutral public values for both platforms in %s',
    (profileName) => {
      const profile = easJson.build[profileName];
      expect(profile.environment).toBe(profileName);
      expect(profile.env).toMatchObject({
        VERIGATE_BUILD_PROFILE: profileName,
        EXPO_PUBLIC_API_URL: 'https://verigate-api-flle.onrender.com/api',
        EXPO_PUBLIC_DEMO_MODE: 'false',
      });
      for (const platform of ['android', 'ios']) {
        const resolved = configureApp.resolveConfig({
          config: baseConfig(),
          environment: { ...profile.env, ...profile[platform].env },
        });
        expect(resolved.extra).toMatchObject({
          buildProfile: profileName,
          buildPlatform: platform,
          apiBaseUrl: 'https://verigate-api-flle.onrender.com/api',
          demoMode: false,
        });
      }
    }
  );

  it('keeps Scan local-notification-only without provider configuration', () => {
    expect(baseConfig().android.googleServicesFile).toBeUndefined();
    expect(JSON.stringify(easJson)).not.toMatch(/GOOGLE_SERVICES|FIREBASE/i);
  });
});
