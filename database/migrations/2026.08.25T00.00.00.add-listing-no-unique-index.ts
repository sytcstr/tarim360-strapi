import type { Knex } from 'knex';
import type { Database } from '@strapi/database';

/**
 * LISTING_L3_LISTING_TYPE_AND_PUBLIC_NUMBER_REPORT.md L3.5/L3.6.
 *
 * Secondary/redundant safety net for the `listings.listing_no` unique
 * index -- same reasoning as
 * database/migrations/2026.07.30T00.00.00.add-engagement-interaction-unique-index.ts's
 * own comment: Strapi runs migrations BEFORE `db.schema.sync()` and
 * BEFORE `bootstrap()`, so `ensureListingNoUniqueIndex` (src/index.ts,
 * which runs inside `bootstrap()` after `runListingNoBackfillOnce`) is
 * the primary, reliable mechanism. This file exists as the standard
 * `database/migrations` entry for completeness and will also succeed on
 * any later boot once the backfill has already run.
 *
 * This is a PARTIAL index (`WHERE published_at IS NOT NULL`), not a
 * plain column-wide unique index -- `listing` has draftAndPublish:true,
 * so every real listing is TWO physical rows (a draft, published_at:
 * null, and the published row) that must carry the IDENTICAL listingNo
 * (confirmed live while writing this fix: a normal PUT edit re-syncs the
 * published row's content from the draft, so a listingNo that only ever
 * existed on the published side gets silently wiped back to null by the
 * very next unrelated edit -- both rows must have it). A plain unique
 * index would reject a row's own draft/published pair for sharing that
 * number; scoping to published-only rows means only genuinely different
 * listings compete for uniqueness. See ensureListingNoUniqueIndex's own
 * comment (src/index.ts) for the SQLite/PostgreSQL portability note.
 *
 * Also unlike the engagement migration, this one has an extra real risk
 * the engagement case didn't: `listing_no` already has existing data
 * (nulls from listings that predate any numbering, and non-unique
 * hash-derived values from the old client-side scheme) the first time
 * this ever runs, and creating a unique index against duplicate values
 * would throw (nulls are never a problem for a unique index by
 * themselves -- standard SQL never treats two nulls as equal). Rather
 * than let a real duplicate crash boot, this checks for one first and
 * skips (warns) if the data isn't clean yet -- `ensureListingNoUniqueIndex`
 * in `bootstrap()` is what actually succeeds once
 * `runListingNoBackfillOnce` has fixed the data, exactly the same
 * "primary vs secondary" division of labor the engagement migration
 * already established.
 */
const TABLE = 'listings';
const INDEX_NAME = 'listings_listing_no_unique';
const COLUMN = 'listing_no';

async function hasDuplicatePublishedListingNo(knex: Knex): Promise<boolean> {
  const dupes = await knex(TABLE)
    .select(COLUMN)
    .whereNotNull(COLUMN)
    .whereNotNull('published_at')
    .groupBy(COLUMN)
    .havingRaw('count(*) > 1');
  return Array.isArray(dupes) && dupes.length > 0;
}

export async function up(knex: Knex, db: Database) {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) {
    strapi?.log?.warn?.(
      `[listing migration] ${TABLE} does not exist yet — skipping unique index creation for this boot; src/index.ts's bootstrap hook is the reliable path for this.`,
    );
    return;
  }
  const hasColumn = await knex.schema.hasColumn(TABLE, COLUMN);
  if (!hasColumn) {
    strapi?.log?.warn?.(
      `[listing migration] ${TABLE} exists but is missing ${COLUMN} — skipping unique index creation this boot.`,
    );
    return;
  }
  const existingIndexes = await (db as any).dialect.schemaInspector.getIndexes(TABLE);
  if (Array.isArray(existingIndexes) && existingIndexes.some((i: { name?: string }) => i.name === INDEX_NAME)) {
    return; // already present
  }
  if (await hasDuplicatePublishedListingNo(knex)) {
    strapi?.log?.warn?.(
      `[listing migration] ${TABLE}.${COLUMN} still has duplicate values among published rows — skipping unique index creation this boot; src/index.ts's bootstrap hook (runListingNoBackfillOnce then ensureListingNoUniqueIndex) is the reliable path for this.`,
    );
    return;
  }
  await knex.raw(`CREATE UNIQUE INDEX ${INDEX_NAME} ON ${TABLE} (${COLUMN}) WHERE published_at IS NOT NULL`);
}

export async function down(knex: Knex, _db: Database) {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;
  await knex.raw(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
}
