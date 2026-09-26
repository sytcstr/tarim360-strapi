/**
 * The mock adapter FABRICATES prices from a formula. It exists for local
 * development and automated tests only and must never write to a production
 * database, whatever the environment flags say.
 *
 * Allowed only when NODE_ENV is explicitly "development" or "test", no Strapi
 * Cloud signal is present, AND AGRI_INGESTION_ENABLED is explicitly true.
 * Anything else (production, unset/unknown NODE_ENV, Cloud) is a hard "no".
 */
export type MockIngestionDecision = {
  allowed: boolean;
  reason:
    | 'allowed'
    | 'production-environment'
    | 'cloud-environment'
    | 'not-enabled';
};

const truthy = (value: unknown): boolean =>
  ['1', 'true', 'yes', 'on'].includes(String(value ?? '').trim().toLowerCase());

export const decideMockAgriIngestion = (
  env: Record<string, string | undefined> = process.env,
): MockIngestionDecision => {
  const nodeEnv = String(env.NODE_ENV ?? '').trim().toLowerCase();
  const cloudSignal = Object.entries(env).some(
    ([key, value]) =>
      key.startsWith('STRAPI_CLOUD') && String(value ?? '').trim().length > 0,
  );
  if (cloudSignal) return { allowed: false, reason: 'cloud-environment' };
  if (nodeEnv !== 'development' && nodeEnv !== 'test') {
    return { allowed: false, reason: 'production-environment' };
  }
  if (!truthy(env.AGRI_INGESTION_ENABLED)) {
    return { allowed: false, reason: 'not-enabled' };
  }
  return { allowed: true, reason: 'allowed' };
};

export const MOCK_INGESTION_DISABLED_LOG =
  'mock agricultural ingestion disabled in production';
