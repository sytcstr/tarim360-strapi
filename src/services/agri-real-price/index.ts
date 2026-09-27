import type { Core } from '@strapi/strapi';
import { formatRealPriceReport, runRealPriceIngestion, type RunOptions } from './runner';
import { readRealPriceMode } from './types';

export { runRealPriceIngestion, formatRealPriceReport } from './runner';
export { readRealPriceMode } from './types';
export { collectTobbObservations } from './tobb/provider';

const truthy = (v: unknown) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());

export type OnceOverrides = Partial<Omit<RunOptions, 'mode'>>;

/**
 * One run according to the mode gate; NEVER throws (a provider or database
 * failure is reported through the log, not propagated to the caller). `off`
 * does no network/database access at all. Whatever the outcome, a summary
 * line is always logged -- a provider that is completely unreachable in
 * dry-run/apply is `status: 'provider-failed'` and still produces the log
 * line (see formatRealPriceReport), it is never silent.
 */
export const runRealPriceIngestionOnce = async (
  strapi: Core.Strapi,
  overrides: OnceOverrides = {},
): Promise<void> => {
  const mode = readRealPriceMode();
  if (mode === 'off') return;
  try {
    const report = await runRealPriceIngestion(strapi, { mode, ...overrides });
    const text = formatRealPriceReport(report);
    if (report.status === 'failed' || report.status === 'provider-failed') strapi.log.error(text);
    else strapi.log.info(text);
  } catch (error) {
    strapi.log.error(`[agri-real-price] unexpected failure: ${String((error as Error)?.message ?? error)}`);
  }
};

export type StartOptions = OnceOverrides & { delayMs?: number };

/**
 * Bootstrap hook.
 *
 *  - off     : does nothing (matches runRealPriceIngestionOnce's own no-op).
 *  - dry-run : ALWAYS scheduled a little after boot (mirrors
 *              runReferenceSeedIfEnabled's boot behaviour) -- setting only
 *              AGRI_REAL_PRICE_INGESTION_MODE=dry-run and deploying is enough
 *              to get the summary log; no extra flag is needed. It never
 *              writes (see runner.ts).
 *  - apply   : NOT run on boot by default -- a redeploy alone must never
 *              start writing to production on its own. Regular apply runs
 *              are cron-driven (config/cron-tasks.ts, twice a day); an
 *              operator can additionally opt into an apply run shortly after
 *              boot with the explicit AGRI_REAL_PRICE_RUN_ON_BOOT=true flag.
 *
 * (Previously this whole hook, dry-run included, required
 * AGRI_REAL_PRICE_RUN_ON_BOOT -- so a production `dry-run` produced no log
 * at all until the next cron tick, unlike the reference-seed dry-run it was
 * meant to match.)
 */
export const startRealPriceIngestionIfEnabled = (strapi: Core.Strapi, options: StartOptions = {}): void => {
  const mode = readRealPriceMode();
  if (mode === 'off') return;
  if (mode === 'apply' && !truthy(process.env.AGRI_REAL_PRICE_RUN_ON_BOOT)) return;
  const { delayMs = 45_000, ...overrides } = options;
  const timer = setTimeout(() => {
    void runRealPriceIngestionOnce(strapi, overrides);
  }, delayMs);
  timer.unref?.();
};
