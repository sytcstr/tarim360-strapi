import type { Knex } from 'knex';
import type { Database } from '@strapi/database';

/**
 * LISTING_L6_SERVER_SEARCH_FILTER_SORT_REPORT.md L6.15.
 *
 * Secondary/redundant safety net for the plain (non-unique) discovery
 * indexes -- same "primary vs secondary" division of labor as
 * 2026.08.25T00.00.00.add-listing-no-unique-index.ts: Strapi runs
 * migrations BEFORE `db.schema.sync()`/`bootstrap()`, so
 * `ensureListingDiscoveryIndexes` (src/index.ts, runs inside
 * `bootstrap()`) is the primary, reliable mechanism; this file is the
 * standard `database/migrations` entry and will also succeed on any
 * later boot. Unlike the listingNo migration, there is no pre-existing-
 * duplicate-data risk here -- these are plain, non-unique indexes, so
 * they never fail against existing data regardless of its content.
 */
const TABLE = 'listings';
const INDEXES: Array<{ name: string; columns: string[] }> = [
  { name: 'listings_mode_index', columns: ['mode'] },
  { name: 'listings_main_type_index', columns: ['main_type'] },
  { name: 'listings_price_index', columns: ['price'] },
  { name: 'listings_city_normalized_index', columns: ['city_normalized'] },
  { name: 'listings_created_at_index', columns: ['created_at'] },
  // LISTING_L19_MARKETPLACE_PRODUCT_GAP_FOUNDATIONS_REPORT.md L19.36:
  // reconciling a real drift this phase's forensic found -- src/index.ts's
  // LISTING_DISCOVERY_INDEXES (the primary mechanism, runs every boot)
  // already had `listings_status_index`, but it was never mirrored here in
  // the secondary/migration-only path. Added here alongside the new
  // owner-index this phase introduces so the two mechanisms agree again.
  { name: 'listings_status_index', columns: ['status'] },
  { name: 'listings_owner_profile_id_index', columns: ['owner_profile_id'] },
];

export async function up(knex: Knex, db: Database) {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) {
    strapi?.log?.warn?.(
      `[listing migration] ${TABLE} does not exist yet — skipping discovery index creation for this boot; src/index.ts's bootstrap hook is the reliable path for this.`,
    );
    return;
  }
  const existingIndexes = await (db as any).dialect.schemaInspector.getIndexes(TABLE);
  const existingNames = new Set(
    (Array.isArray(existingIndexes) ? existingIndexes : [])
      .map((i: { name?: string }) => i.name)
      .filter(Boolean),
  );
  for (const { name, columns } of INDEXES) {
    if (existingNames.has(name)) continue;
    const hasAllColumns = (
      await Promise.all(columns.map((c) => knex.schema.hasColumn(TABLE, c)))
    ).every(Boolean);
    if (!hasAllColumns) {
      strapi?.log?.warn?.(
        `[listing migration] ${TABLE} missing column(s) for ${name} — skipping this boot.`,
      );
      continue;
    }
    await knex.schema.alterTable(TABLE, (t) => {
      t.index(columns, name);
    });
  }
}

export async function down(knex: Knex, _db: Database) {
  const hasTable = await knex.schema.hasTable(TABLE);
  if (!hasTable) return;
  for (const { name } of INDEXES) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.dropIndex([], name);
    });
  }
}
