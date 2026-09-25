import { asString, parseBool } from './catalog';

/**
 * Purchase configuration. Every value is read lazily (at call time), never at
 * module load, so a test can set env before booting and so nothing here is
 * silently frozen to a stale value.
 */

/**
 * Soft verify (accept ANY receipt) exists only to develop against the purchase
 * flow without store credentials. It is honoured ONLY when NODE_ENV is
 * explicitly `development` or `test`. In every other environment -- including
 * production, and including an unset NODE_ENV -- the flag is ignored and the
 * real provider verification always runs (which, without credentials, fails
 * closed). A production instance that has the flag set therefore never grants
 * an entitlement for a fake receipt.
 */
export const isSoftVerifyActive = (): boolean => {
  const env = asString(process.env.NODE_ENV).toLowerCase();
  const devLike = env === 'development' || env === 'test';
  return devLike && parseBool(process.env.PURCHASE_VERIFY_SOFT, false);
};

/** True when soft verify was REQUESTED but is being refused (misconfiguration). */
export const isSoftVerifyRefused = (): boolean =>
  parseBool(process.env.PURCHASE_VERIFY_SOFT, false) && !isSoftVerifyActive();

export const googleConfig = () => ({
  packageName: asString(process.env.GOOGLE_PLAY_PACKAGE_NAME),
  serviceAccountEmail: asString(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL),
  serviceAccountPrivateKey: asString(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY).replace(
    /\\n/g,
    '\n',
  ),
  // Pub/Sub push authentication (OIDC): the audience configured on the push
  // subscription and the service account that subscription authenticates as.
  pubsubAudience: asString(process.env.GOOGLE_PUBSUB_AUDIENCE),
  pubsubServiceAccountEmail: asString(process.env.GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL),
});

export const appleConfig = () => ({
  sharedSecret: asString(process.env.APPLE_SHARED_SECRET),
  bundleId: asString(process.env.APPLE_BUNDLE_ID),
});

/** SHA-256 fingerprint (uppercase hex, no colons) of Apple Root CA - G3. */
export const APPLE_ROOT_CA_G3_SHA256 =
  '63343ABFB89A6A03EBB57E9B3F5FA7BE7C4F5C756F3017B3A8C488C3653E9179';

/** Trusted Apple roots. Overridable (comma-separated) only for tests. */
export const trustedAppleRoots = (): string[] => {
  const custom = asString(process.env.APPLE_TRUSTED_ROOT_SHA256);
  const list = custom
    ? custom.split(',').map((x) => x.replace(/[^0-9a-fA-F]/g, '').toUpperCase()).filter(Boolean)
    : [APPLE_ROOT_CA_G3_SHA256];
  return list;
};
