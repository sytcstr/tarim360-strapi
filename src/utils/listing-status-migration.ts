import type { Core } from '@strapi/strapi';

/**
 * İlan1 lifecycle/moderation: the business lifecycle field moved from
 * `status` to `listingStatus`.
 *
 * Why: Strapi v5's Content Manager reserves the request/response name
 * `status` for a document's draft/published state. On a Draft & Publish
 * content type with a business attribute literally called `status`, the
 * admin panel (a) reports the row's publication state ("published") in
 * place of the stored value -- so the enum dropdown renders blank -- and
 * (b) validates any submitted `status` as `draft|published`, answering
 * "Invalid status" to `pending`/`rejected`. Result: pending/rejected
 * could never be set by anyone. A differently named field has no such
 * collision.
 *
 * Data safety (this is the non-destructive half of a two-phase change):
 * Strapi's schema sync DROPS a column whose attribute is removed from the
 * schema, and it runs BEFORE bootstrap. So phase 1 (this) only ADDS
 * `listing_status` and keeps the legacy `status` attribute/column in the
 * schema untouched; this backfill then copies the legacy values across.
 * Phase 2 (a later deploy, after this copy is verified in production)
 * removes the legacy attribute. A schema-level default ('active') is
 * stamped onto every pre-existing row when the new column is added, so an
 * `IS NULL` guard would silently skip real pending/rejected rows -- the
 * copy is therefore unconditional for every row with a legacy value,
 * guarded by a run-once flag so it can never overwrite later moderation
 * edits made in `listingStatus`.
 *
 * Portable SQL only (plain UPDATE ... SET a = b), identical on SQLite
 * and Postgres.
 */
export const runListingStatusToListingStatusMigrationOnce = async (
  strapi: Core.Strapi,
) => {
  const appStore = strapi.store({ type: 'core', name: 'bootstrap' });
  const key = 'listing_status_to_listing_status_v1_done';
  if ((await appStore.get({ key })) === true) {
    strapi.log.info('Listing status -> listingStatus migration skipped (already done).');
    return;
  }

  const knex = (strapi.db as any).connection;
  const table = 'listings';
  const hasNew = await knex.schema.hasColumn(table, 'listing_status');
  if (!hasNew) {
    // Should never happen this late in boot (schema sync just ran) --
    // surface it loudly rather than mark the migration done.
    throw new Error(
      `Column "${table}.listing_status" does not exist after schema sync.`,
    );
  }

  const hasLegacy = await knex.schema.hasColumn(table, 'status');
  let copied = 0;
  if (hasLegacy) {
    copied = await knex(table)
      .whereNotNull('status')
      .update({ listing_status: knex.raw('??', ['status']) });
  }

  await appStore.set({ key, value: true });
  strapi.log.info(
    `Listing status -> listingStatus migration completed: copied legacy status onto ${copied} row(s) (legacy column present: ${hasLegacy}).`,
  );
};
