import type { Core } from '@strapi/strapi';
import { computeListingSearchFields } from './listing-search-fields';

const LISTING_UID = 'api::listing.listing';

/**
 * LISTING_L6_SERVER_SEARCH_FILTER_SORT_REPORT.md L6.4/L6.7.
 *
 * Every listing created before this phase has null `city`/`district`/
 * `cityNormalized`/`searchNormalized` -- those columns didn't exist yet.
 * Without this backfill, the new server-side search/city filter would
 * silently make every pre-existing listing unfindable by search or city
 * (a `WHERE searchNormalized ILIKE ...`/`cityNormalized = ...` filter
 * simply never matches a null column), even though the listing itself is
 * unchanged and still live. This runs exactly once (the same
 * `strapi.store` app-store flag pattern `runListingNoBackfillOnce`
 * already established), deriving each row's search fields from its own
 * already-stored `title`/`description`/`mainType`/`subType`/`location`/
 * `ownerCity` -- no data is deleted or recreated, and both the draft and
 * published row sharing each documentId are updated identically (the
 * exact same reasoning as the listingNo backfill: a plain PUT update
 * later would otherwise re-sync the published row's content FROM the
 * still-null draft and wipe these fields right back out).
 */
export const runListingSearchFieldsBackfillOnce = async (
  strapi: Core.Strapi,
) => {
  const appStore = strapi.store({ type: 'core', name: 'bootstrap' });
  const key = 'listing_search_fields_backfill_v1_done';
  if ((await appStore.get({ key })) === true) {
    strapi.log.info('Listing search-fields backfill skipped (already done).');
    return;
  }

  const rows = await strapi.db.query(LISTING_UID).findMany({
    where: { publishedAt: { $notNull: true } },
    select: [
      'documentId',
      'title',
      'description',
      'mainType',
      'subType',
      'location',
      'ownerCity',
    ],
  } as any);

  let updated = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const documentId = String((row as any)?.documentId ?? '').trim();
    if (!documentId) continue;
    const searchFields = computeListingSearchFields(row as any);
    await strapi.db.query(LISTING_UID).updateMany({
      where: { documentId },
      data: searchFields as any,
    } as any);
    updated += 1;
  }

  await appStore.set({ key, value: true });
  strapi.log.info(
    `Listing search-fields backfill completed: updated=${updated} listing(s).`,
  );
};
