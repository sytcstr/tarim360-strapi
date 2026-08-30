import type { Core } from '@strapi/strapi';

const LISTING_UID = 'api::listing.listing';

/**
 * LISTING_L14_LIFECYCLE_STATE_MACHINE_REPORT.md L14.25: `status` is an
 * enumeration with a schema-level default of 'active', but a schema
 * default only applies to a row created AFTER the field existed in the
 * schema -- a row from before this field was added can carry a real NULL
 * in its `status` column at the DB level. listing-query.ts's discovery
 * filter (`status: { $eq: 'active' }`) would silently exclude any such
 * row from ALL public discovery/popular results even though the listing
 * itself is unchanged and still perfectly live. This backfill closes
 * that gap defensively -- idempotent (same app-store-flag pattern
 * runListingNoBackfillOnce/runListingSearchFieldsBackfillOnce already
 * use) and a safe no-op if no null-status row ever existed.
 */
export const runListingStatusBackfillOnce = async (strapi: Core.Strapi) => {
  const appStore = strapi.store({ type: 'core', name: 'bootstrap' });
  const key = 'listing_status_backfill_v1_done';
  if ((await appStore.get({ key })) === true) {
    strapi.log.info('Listing status backfill skipped (already done).');
    return;
  }

  const nullCount = await strapi.db.query(LISTING_UID).count({
    where: { status: { $null: true } },
  } as any);

  if (nullCount > 0) {
    await strapi.db.query(LISTING_UID).updateMany({
      where: { status: { $null: true } },
      data: { status: 'active' },
    } as any);
  }

  await appStore.set({ key, value: true });
  strapi.log.info(
    `Listing status backfill completed: updated=${nullCount} listing(s) with a null status to 'active'.`,
  );
};
