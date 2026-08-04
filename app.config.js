const PROFILED_PLATFORMS = new Set(['android', 'ios']);

function nonEmpty(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseBoolean(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new Error(`${label} must be either true or false`);
}

function safeProfiledApiUrl(value) {
  if (!nonEmpty(value)) throw new Error('A profiled Scan build requires an API URL');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('The profiled Scan API URL is malformed');
  }
  const hostname = parsed.hostname.toLowerCase();
  const loopback = hostname === 'localhost' || hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  const pathname = parsed.pathname.replace(/\/$/, '');
  if (
    parsed.protocol !== 'https:' || loopback || pathname !== '/api' ||
    parsed.username || parsed.password || parsed.search || parsed.hash
  ) {
    throw new Error('The profiled Scan API URL must be a credential-free HTTPS origin ending in /api');
  }
  parsed.pathname = pathname;
  return parsed.toString().replace(/\/$/, '');
}

function resolveConfig({ config, environment = process.env }) {
  const buildProfile = nonEmpty(environment.VERIGATE_BUILD_PROFILE) ||
    nonEmpty(environment.EAS_BUILD_PROFILE);
  const buildPlatform = nonEmpty(environment.VERIGATE_BUILD_PLATFORM) ||
    nonEmpty(environment.EAS_BUILD_PLATFORM);
  const profiled = buildProfile !== null;
  if (profiled && !PROFILED_PLATFORMS.has(buildPlatform)) {
    throw new Error('A profiled Scan build supports only an explicit android or ios platform; web is unsupported');
  }

  const configuredApiUrl = nonEmpty(environment.EXPO_PUBLIC_API_URL) ||
    nonEmpty(config.extra?.apiBaseUrl) || 'http://localhost:3000/api';
  const apiBaseUrl = profiled ? safeProfiledApiUrl(configuredApiUrl) : configuredApiUrl;
  const demoMode = parseBoolean(
    environment.EXPO_PUBLIC_DEMO_MODE,
    config.extra?.demoMode === true,
    'Scan demo mode'
  );
  if (profiled && demoMode) throw new Error('Scan demo mode must be disabled for profiled builds');

  const extra = { ...config.extra, apiBaseUrl, demoMode };
  delete extra.buildProfile;
  delete extra.buildPlatform;
  if (profiled) {
    extra.buildProfile = buildProfile;
    extra.buildPlatform = buildPlatform;
  }
  return { ...config, extra };
}

function configureApp({ config }) {
  return resolveConfig({ config });
}

configureApp.resolveConfig = resolveConfig;
module.exports = configureApp;
