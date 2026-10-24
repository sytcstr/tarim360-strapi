import type { Core } from '@strapi/strapi';
import { syncOwnerPremiumFlags } from './premium-sync';

/**
 * ILAN OLUSTURMA RAPORU ROUND 2 (item 4) -- CORRECTION: this function used
 * to live in src/index.ts and was imported from there by config/cron-
 * tasks.ts. That import made Strapi's lightweight CONFIG-file transpiler
 * (a separate, simpler esbuild "transform" pass @strapi/core's own
 * load-config-file.ts uses for *.ts files under config/ -- distinct from
 * the full compilation the real src/ tree normally goes through to boot)
 * pull in index.ts's entire top-level import list -- twenty-odd unrelated
 * modules, including utils/reference-seed.ts, which has nothing to do with
 * premium flags at all. Confirmed live: a full sequential run of every
 * integration test file hit "Could not load js config file .../cron-
 * tasks.js: ... reference-seed.js: Unexpected end of file" on two files,
 * reproducibly tied to this import edge -- each test file's own fresh
 * compileStrapi() call re-triggers that same config-transform pass, and a
 * partially-written dist output from one test's pass can be read mid-
 * write by the very next one.
 *
 * Fix: this function now lives in its own file with a minimal, config-
 * safe dependency (only premium-sync.ts) -- src/index.ts's bootstrap()
 * and config/cron-tasks.ts's cron task both import it from HERE, so
 * cron-tasks.ts never has to pull in index.ts (or its reference-seed.ts/
 * agri-real-price/etc. dependents) at all. No business logic changed.
 *
 * isPremiumOwner is a stored listing column used as a Popular/Trending
 * ranking tiebreak (listing-popular-query.ts's TIER2_SORT) that only gets
 * re-synced from the owner's live profile on a profile-setting write or a
 * full server restart -- an owner whose Premium naturally expires by
 * date, with neither of those happening in between, would otherwise keep
 * ranking as premium indefinitely.
 */
export const runPremiumFlagsBackfill = async (strapi: Core.Strapi) => {
  try {
    const rows = await strapi.db.query('api::profile-setting.profile-setting').findMany({
      select: ['id'],
      orderBy: { id: 'asc' },
    } as any);

    for (const row of Array.isArray(rows) ? rows : []) {
      const id = Number((row as any)?.id);
      if (!Number.isInteger(id) || id <= 0) continue;
      try {
        const entry = await strapi.entityService.findOne(
          'api::profile-setting.profile-setting' as any,
          id as any,
          {
            fields: ['profileId', 'activePremium', 'activePremiumSubscription'],
          },
        );
        await syncOwnerPremiumFlags(strapi, entry as Record<string, unknown>);
      } catch (_) {}
    }

    strapi.log.info('Premium listing flag backfill completed.');
  } catch (e) {
    strapi.log.error(`Premium listing flag backfill failed: ${e}`);
  }
};
