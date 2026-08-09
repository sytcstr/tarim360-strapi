/**
 * Faz D7-B.6 — Hub Content like recount (covers both Knowledge Hub
 * content and Farmer Questions, since both are rows in the same
 * api::hub-content.hub-content collection — see D7-B's report for why
 * Farmer Questions deliberately reuse targetType='hub-content' rather
 * than getting a separate targetType).
 *
 * NOT run against production by this phase — prepared as a file/script
 * only, per the D7-B mandate. Run manually, later, with explicit intent:
 *
 *   npx tsx scripts/recount-hub-content-engagement.ts
 *
 * What it does
 * ------------
 * engagement_interactions is the real source of truth for like
 * membership (see setMembership, src/api/engagement/services/
 * engagement-v1.ts). This script recomputes each hub-content row's
 * `likes` as `COUNT(*) FROM engagement_interactions WHERE
 * targetType='hub-content' AND targetId=<row.id> AND kind='like'` and
 * writes it back only if it differs from the currently stored value —
 * idempotent, safe to re-run. No `favorite`/`view` recount: hub-content
 * only supports `like` (DOMAIN_SUPPORT['hub-content']).
 *
 * Why this is likely a no-op today
 * ---------------------------------
 * D6-B (sanitize hub-content engagement fields on create/update) and
 * this phase's delegation of toggleFarmerQuestionLike both landed
 * *before* any Flutter client was migrated to actually call
 * setMembership for hub-content likes — meaning engagement_interactions
 * is very likely still empty for this collection in any real database,
 * and every row's `likes` still reflects whatever the old client-side-
 * computed-delta mechanisms (HubContentRepo._syncLike,
 * FarmerQuestionsRepo.toggleLike) last wrote before D6-B started
 * silently ignoring their PATCHes. This script exists so that, once
 * Flutter actually starts writing real interaction rows (Faz D6/D7-F),
 * any such stale pre-migration counts can be safely corrected to match
 * reality — running it before that point would simply zero out every
 * row's `likes` (a real correction, not a bug, but worth being aware of
 * the timing).
 *
 * Safety
 * ------
 * Refuses to run against a non-sqlite / non-local database, mirroring
 * scripts/recount-processed-product-engagement.ts's guard.
 */
import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const HUB_CONTENT_UID = 'api::hub-content.hub-content';
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
    const rows: any[] = await strapi.db.query(HUB_CONTENT_UID).findMany({
      select: ['id', 'kind', 'likes'],
    });

    let changed = 0;
    let farmerQuestionRows = 0;
    for (const row of rows) {
      if (String(row.kind ?? '').trim() === 'farmerQuestion') farmerQuestionRows++;
      const likeRows = await strapi.db.query(INTERACTION_UID).findMany({
        where: { targetType: 'hub-content', targetId: String(row.id), kind: 'like' },
        select: ['id'],
      });
      const realLikes = likeRows.length;
      const currentLikes = Number(row.likes ?? 0);

      if (realLikes === currentLikes) continue;

      await strapi.db.query(HUB_CONTENT_UID).update({
        where: { id: row.id },
        data: { likes: realLikes },
      });
      changed++;
      // eslint-disable-next-line no-console
      console.log(
        `hub-content #${row.id} (kind=${row.kind ?? 'unknown'}): likes ${currentLikes} -> ${realLikes}`,
      );
    }

    // eslint-disable-next-line no-console
    console.log(
      `Recount complete. ${changed}/${rows.length} row(s) corrected (${farmerQuestionRows} farmerQuestion row(s) among ${rows.length} total).`,
    );
  } finally {
    await strapi.destroy();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Recount failed:', error);
  process.exitCode = 1;
});
