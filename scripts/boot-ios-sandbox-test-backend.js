/**
 * "Paketler ve Fiyatlar" / TestFlight follow-up (THIRD PASS): boots a REAL
 * Strapi instance (not a node:test harness -- stays alive, like the
 * existing `boot-e2e-backend.js`) against its OWN throwaway SQLite file,
 * on its own fixed port, bound to 0.0.0.0 (Strapi's own default) so a
 * REAL iPhone on the SAME Wi-Fi network can reach it at this machine's
 * LAN IP.
 *
 * This is a genuinely SEPARATE backend from production:
 *  - Production is the hosted Strapi Cloud instance Flutter's
 *    `DEFAULT_STRAPI_BASE_URL` points to by default (strapi_service.dart) --
 *    a different physical host entirely, not this machine.
 *  - This process uses its own, brand-new SQLite file (deleted and
 *    recreated on every run) -- never this machine's own local dev
 *    `.tmp/data.db`, and categorically never production's database.
 *  - No production data is ever copied here. Every account used against
 *    this backend is a fresh test account, registered directly against
 *    THIS instance.
 *
 * What IS allowed here that is refused everywhere else:
 *  - NODE_ENV=test + PURCHASE_ALLOW_SANDBOX_ENTITLEMENTS=true, so a real
 *    Apple SANDBOX (TestFlight) transaction can actually be granted --
 *    see `allowSandboxPurchaseEntitlements()` (purchase/lib/config.ts).
 *
 * What is NEVER loosened, even here:
 *  - Apple's signature chain is verified against the REAL Apple root CA
 *    (APPLE_TRUSTED_ROOT_SHA256 is deliberately left UNSET -- it only
 *    exists for the node:test suite's own fake certificate chain).
 *  - APPLE_BUNDLE_ID is the app's REAL bundle id -- a transaction for any
 *    other app is still rejected exactly as in production.
 *  - Every other ownership/idempotency/conflict check in purchase.ts
 *    runs completely unchanged.
 */
const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.IOS_SANDBOX_PORT || 14500);
const DB_FILE = path.join(__dirname, '..', 'tests', 'integration', '.tmp-ios-sandbox-test-backend.db');
const REAL_BUNDLE_ID = 'com.tarim360arti1.ios';

async function main() {
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  process.env.DATABASE_CLIENT = 'sqlite';
  process.env.DATABASE_FILENAME = path.relative(path.join(__dirname, '..'), DB_FILE);
  process.env.PORT = String(PORT);
  process.env.NODE_ENV = 'test';
  process.env.PURCHASE_ALLOW_SANDBOX_ENTITLEMENTS = 'true';
  process.env.APPLE_BUNDLE_ID = REAL_BUNDLE_ID;
  // Deliberately NOT setting APPLE_TRUSTED_ROOT_SHA256 -- it must keep
  // trusting the real Apple root (config.ts's own default), never a
  // test-only fixture chain.
  delete process.env.APPLE_TRUSTED_ROOT_SHA256;

  const { createStrapi, compileStrapi } = require('@strapi/strapi');
  const compiled = await compileStrapi();
  const strapi = await createStrapi(compiled).load();
  await strapi.server.listen(PORT);
  // eslint-disable-next-line no-console
  console.log(`IOS_SANDBOX_TEST_BACKEND_READY port=${PORT} bundleId=${REAL_BUNDLE_ID} db=${process.env.DATABASE_FILENAME}`);

  const shutdown = async () => {
    try {
      await strapi.server.close();
      await strapi.destroy();
    } finally {
      if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error('IOS_SANDBOX_TEST_BACKEND_BOOT_FAILED', e);
  process.exit(1);
});
