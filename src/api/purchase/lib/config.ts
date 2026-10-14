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

/**
 * "Paketler ve Fiyatlar" / TestFlight follow-up: by default this backend
 * has NO separate sandbox entitlement store -- a verified Apple SANDBOX
 * transaction is rejected outright (`purchase.ts`'s `sandbox_unsupported`),
 * and the doping/listing-quota consumption checks (`activateRocket`,
 * `canCreateNextNormalListing`) exclude sandbox-tagged purchase-event
 * rows. That is correct and required for the real, production-facing
 * deployment -- TestFlight and the real App Store would otherwise write
 * the exact same tables.
 *
 * A genuinely SEPARATE deployment -- its own process, pointed (via
 * DATABASE_FILENAME/DATABASE_HOST/etc.) at a database that holds no real
 * customer data, used ONLY so a TestFlight build can validate Premium/
 * doping/listing-quota purchases end-to-end -- may opt in to treating a
 * verified sandbox transaction as grantable, exactly like a real one.
 * This mirrors `isSoftVerifyActive`'s own gate exactly on purpose:
 * honoured ONLY when NODE_ENV is explicitly `development` or `test`, so
 * a real production deployment (NODE_ENV=production -- Strapi's own
 * standard convention, and what this app's production backend runs
 * under) ignores this flag even if it were ever accidentally set in its
 * own environment -- the same hard, code-level guarantee soft-verify
 * already relies on; this is not merely a documented convention.
 *
 * This flag does NOT, by itself, make the database separate -- that is
 * an operational fact of how/where this process is deployed, not
 * something any in-process flag can create. It only ever matters paired
 * with a genuinely separate deployment (its own DATABASE_FILENAME/
 * DATABASE_HOST, never the production database).
 */
export const allowSandboxPurchaseEntitlements = (): boolean => {
  const env = asString(process.env.NODE_ENV).toLowerCase();
  const devLike = env === 'development' || env === 'test';
  return devLike && parseBool(process.env.PURCHASE_ALLOW_SANDBOX_ENTITLEMENTS, false);
};

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
