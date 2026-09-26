import type { Core } from '@strapi/strapi';
import { formatRealPriceReport, runRealPriceIngestion } from './runner';
import { readRealPriceMode } from './types';

export { runRealPriceIngestion, formatRealPriceReport } from './runner';
export { readRealPriceMode } from './types';
export { collectTobbObservations } from './tobb/provider';

const truthy = (v: unknown) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());

/** One scheduled/one-shot run according to the mode gate. Never throws. */
export const runRealPriceIngestionOnce = async (strapi: Core.Strapi): Promise<void> => {
  const mode = readRealPriceMode();
  if (mode === 'off') return;
  try {
    const report = await runRealPriceIngestion(strapi, { mode });
    const text = formatRealPriceReport(report);
    if (report.status === 'failed' || report.status === 'provider-failed') strapi.log.error(text);
    else strapi.log.info(text);
  } catch (error) {
    strapi.log.error(`[agri-real-price] unexpected failure: ${String((error as Error)?.message ?? error)}`);
  }
};

/**
 * Bootstrap hook. `off` (default) does nothing. Otherwise an optional one-shot
 * run a little after boot (AGRI_REAL_PRICE_RUN_ON_BOOT=true, useful for the
 * first production dry-run); regular runs are cron-driven (config/cron-tasks.ts).
 */
export const startRealPriceIngestionIfEnabled = (strapi: Core.Strapi): void => {
  if (readRealPriceMode() === 'off') return;
  if (!truthy(process.env.AGRI_REAL_PRICE_RUN_ON_BOOT)) return;
  const timer = setTimeout(() => {
    void runRealPriceIngestionOnce(strapi);
  }, 45_000);
  timer.unref?.();
};
