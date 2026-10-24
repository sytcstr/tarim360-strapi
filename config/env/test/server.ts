/**
 * ILAN OLUSTURMA RAPORU ROUND 3 (item 2): Strapi's own built-in
 * per-environment config override (config/env/<NODE_ENV>/*.ts, deep-merged
 * over the base config/*.ts by @strapi/core's configuration loader --
 * see configuration/index.js's `_.merge(rootConfig, defaultConfig,
 * baseConfig, envConfig)`) -- no new infrastructure, no node_modules
 * change, and the base config/server.ts (`cron.enabled: true`,
 * unconditional) is untouched, so every REAL (non-test) boot keeps
 * scheduling cron exactly as before.
 *
 * Only disables the node-schedule SCHEDULER itself for NODE_ENV=test
 * (see package.json's test:integration script, which loads
 * .env.test -> NODE_ENV=test via Node's own --env-file flag). This does
 * NOT remove or skip any cron/backfill task -- `cron.tasks` from the
 * base config is preserved by the deep merge; tests that need to verify
 * cron/backfill behavior do so by invoking the task function directly
 * (e.g. runPremiumFlagsBackfill), the same controlled/manual pattern
 * already used by the round-2 G1 test, never by waiting for the
 * scheduler to fire.
 *
 * Root cause this PARTIALLY closes -- CORRECTION after a real full-suite
 * run: a stale, already-in-flight node-schedule Job invocation can fire
 * AFTER strapi.destroy() during a sequential multi-file test run,
 * crashing the Node test-runner process with "ReferenceError: strapi is
 * not defined" from inside @strapi/core's own cron service. This flag
 * confirmed removes OUR OWN application tasks (config/server.ts's
 * cron.tasks -- the per-minute deleted-account purge and the hourly
 * premium-flag backfill) from ever being scheduled in NODE_ENV=test,
 * verified via a direct inspection script (strapi.get('cron').jobs is
 * empty of our own task names under this override).
 *
 * It does NOT fully eliminate the crash. A real full backend-suite run
 * (round 3) still showed it twice (764 tests, 762 pass, 2 fail -- both
 * this exact ReferenceError, in otherwise-unrelated test files). Root
 * cause of the SURVIVING failures: several of Strapi's own BUNDLED
 * plugins register their own cron jobs directly via `strapi.cron.add()`
 * at plugin-bootstrap time, entirely independent of this `cron.enabled`
 * flag (which only gates `config/server.ts`'s own `cron.tasks`) --
 * confirmed in @strapi/upload/dist/server/services/weekly-metrics.js
 * (`registerCron()`, called unconditionally from upload's bootstrap.js),
 * which computes a fresh schedule firing just 15 SECONDS after boot
 * whenever the plugin store has no prior schedule saved -- exactly the
 * case on this harness's always-fresh, throwaway-SQLite-per-file
 * pattern. Similar unconditional `cron.add()` calls exist in
 * @strapi/admin, @strapi/content-releases and @strapi/review-workflows.
 * None of them can be disabled from this file, from `config/server.ts`,
 * or from `STRAPI_TELEMETRY_DISABLED` (upload's weeklyMetrics registers
 * the cron regardless of telemetry state; only the eventual network send
 * is telemetry-gated) without either editing node_modules (out of
 * bounds) or adding defensive, error-swallowing teardown code around
 * @strapi/core's cron error handling (a materially different, wider
 * change than the test-isolation scope authorized for this round).
 *
 * Left deliberately OPEN and unresolved by design, same as the quota
 * race and the hourly premium-cron delay bound -- not silently papered
 * over. See the round-3 report for the exact two failing test files.
 */
const config = () => ({
  cron: {
    enabled: false,
  },
});

export default config;
