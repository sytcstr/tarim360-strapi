/**
 * Faz D5-B.6 — Processed Product engagement recount (like/favorite only).
 *
 * NOT run against production by this phase — prepared as a file/script
 * only, per the D5-B mandate. Run manually, later, with explicit intent:
 *
 *   npx tsx scripts/recount-processed-product-engagement.ts
 *
 * What it does
 * ------------
 * engagement_interactions is the real source of truth for like/favorite
 * membership (see setMembership, src/api/engagement/services/
 * engagement-v1.ts). This script recomputes each processed-product row's
 * likeCount/favoriteCount as `COUNT(*) FROM engagement_interactions WHERE
 * targetType='processed-product' AND targetId=<row.id> AND kind=<like|
 * favorite>` and writes it back only if it differs from the currently
 * stored value — idempotent, safe to re-run.
 *
 * Why only like/favorite, not viewCount
 * --------------------------------------
 * engagement_views stores one row per (actor, target) pair with a
 * lastViewedAt timestamp — a *returning* actor after the 24h window
 * increments viewCount again without a new row (see
 * engagement-view-service.ts). So, unlike like/favorite, the row count in
 * engagement_views does NOT equal the true historical viewCount — there
 * is no way to exactly reconstruct it after the fact. viewCount is left
 * untouched; it is only ever mutated going forward via registerView's own
 * atomic increment.
 *
 * Why this is likely a no-op today
 * ---------------------------------
 * D5-B's integration tests (processed-product-engagement.integration.
 * test.ts, "generic update/create ignores a client-supplied ...") proved
 * empirically, via a real boot, that PUT/POST /processed-products (the
 * only pre-D5-B write path that ever touched likeCount/favoriteCount)
 * returns 403 for an authenticated user on a freshly-provisioned
 * instance — meaning the old client-side-computed-count sync mechanism
 * (ProcessedProductInsightsStore._syncProductMetrics, Flutter) was very
 * likely never actually persisting anything server-side. A real
 * production instance may differ if that permission was ever granted
 * out-of-band (e.g. clicked in the admin panel) — this script exists
 * precisely to correct for that possibility, safely and idempotently,
 * without assuming either way.
 *
 * Safety
 * ------
 * Refuses to run against a non-sqlite / non-local database, mirroring
 * scripts/seed-agri-reference-data.js's guard — recompute-in-place is
 * low-risk (idempotent, only touches two integer columns) but this
 * script has still never been run against a real dataset, so the same
 * "local only, no cloud signal" discipline applies until someone
 * consciously runs it against a real target.
 */
import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const PRODUCT_UID = 'api::processed-product.processed-product';
const INTERACTION_UID = 'api::engagement-interaction.engagement-interaction';

const loadLocalEnv = (): void => {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
};

const assertSafeLocalTarget = (): void => {
  loadLocalEnv();
  const nodeEnv = String(process.env.NODE_ENV ?? 'development').toLowerCase();
  const databaseClient = String(process.env.DATABASE_CLIENT ?? 'sqlite').toLowerCase();
  const databaseUrl = String(process.env.DATABASE_URL ?? '').trim();
  const databaseHost = String(process.env.DATABASE_HOST ?? '').trim().toLowerCase();
  const cloudSignal = Object.entries(process.env).some(
    ([key, value]) => key.startsWith('STRAPI_CLOUD') && String(value ?? '').trim().length > 0,
  );

  if (nodeEnv === 'production') {
    throw new Error('Recount refused: NODE_ENV=production is not allowed without --force-production.');
  }
  if (databaseClient !== 'sqlite') {
    throw new Error(`Recount refused: DATABASE_CLIENT must be sqlite, received ${databaseClient}.`);
  }
  if (databaseUrl) {
    throw new Error('Recount refused: DATABASE_URL is configured.');
  }
  if (databaseHost && !['localhost', '127.0.0.1', '::1'].includes(databaseHost)) {
    throw new Error('Recount refused: a non-local DATABASE_HOST is configured.');
  }
  if (cloudSignal) {
    throw new Error('Recount refused: Strapi Cloud environment variables detected.');
  }
};

async function main(): Promise<void> {
  const allowProduction = process.argv.includes('--force-production');
  if (!allowProduction) {
    assertSafeLocalTarget();
  }

  const compiled = await compileStrapi();
  const strapi = await createStrapi(compiled).load();

  try {
    const products: any[] = await strapi.db.query(PRODUCT_UID).findMany({
      select: ['id', 'likeCount', 'favoriteCount'],
    });

    let changed = 0;
    for (const product of products) {
      const [likeRows, favoriteRows] = await Promise.all([
        strapi.db.query(INTERACTION_UID).findMany({
          where: { targetType: 'processed-product', targetId: String(product.id), kind: 'like' },
          select: ['id'],
        }),
        strapi.db.query(INTERACTION_UID).findMany({
          where: { targetType: 'processed-product', targetId: String(product.id), kind: 'favorite' },
          select: ['id'],
        }),
      ]);
      const realLikeCount = likeRows.length;
      const realFavoriteCount = favoriteRows.length;
      const currentLikeCount = Number(product.likeCount ?? 0);
      const currentFavoriteCount = Number(product.favoriteCount ?? 0);

      if (realLikeCount === currentLikeCount && realFavoriteCount === currentFavoriteCount) {
        continue;
      }

      await strapi.db.query(PRODUCT_UID).update({
        where: { id: product.id },
        data: { likeCount: realLikeCount, favoriteCount: realFavoriteCount },
      });
      changed++;
      // eslint-disable-next-line no-console
      console.log(
        `processed-product #${product.id}: likeCount ${currentLikeCount} -> ${realLikeCount}, ` +
          `favoriteCount ${currentFavoriteCount} -> ${realFavoriteCount}`,
      );
    }

    // eslint-disable-next-line no-console
    console.log(`Recount complete. ${changed}/${products.length} row(s) corrected.`);
  } finally {
    await strapi.destroy();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Recount failed:', error);
  process.exitCode = 1;
});
