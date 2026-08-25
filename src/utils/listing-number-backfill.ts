import type { Core } from '@strapi/strapi';

const LISTING_UID = 'api::listing.listing';

/**
 * LISTING_L3_LISTING_TYPE_AND_PUBLIC_NUMBER_REPORT.md L3.6.
 *
 * Every listing created before this phase either has no listingNo at all,
 * or one written by the OLD client-side mechanism
 * (deriveListingNoFromRawId in listing_model.dart -- a hash of the row's
 * raw id, never sent through any server-side uniqueness check). Neither
 * is safe to keep as the backing value for a real, unique, immutable
 * public number: nulls would violate the new unique index outright, and
 * the hash-derived values were never guaranteed collision-free.
 *
 * This runs exactly once (flagged via the same `strapi.store` pattern
 * runOfferIdDedupeOnce already uses for an analogous one-time cleanup)
 * and reassigns every existing PUBLISHED listing a fresh, sequential,
 * unique integer in creation order (oldest first), then this same
 * function's caller (src/index.ts's bootstrap) creates the unique index
 * on listing_no immediately after -- safe only because this backfill has
 * just guaranteed there are no nulls or duplicates left. New listings
 * created after this point get their number from nextListingNo's
 * MAX(listingNo)+1, which naturally continues from whatever this backfill
 * assigns as the highest number. No data is deleted or recreated -- only
 * the listingNo column is corrected in place, on both the draft and
 * published row sharing each documentId (draftAndPublish:true means every
 * create left a pair; both must carry the same number, exactly like
 * activateRocket's own documentId-wide updateMany already does).
 */
export const runListingNoBackfillOnce = async (strapi: Core.Strapi) => {
  const appStore = strapi.store({ type: 'core', name: 'bootstrap' });
  const key = 'listing_no_backfill_v1_done';
  if ((await appStore.get({ key })) === true) {
    strapi.log.info('Listing number backfill skipped (already done).');
    return;
  }

  const rows = await strapi.db.query(LISTING_UID).findMany({
    where: { publishedAt: { $notNull: true } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: ['id', 'documentId', 'listingNo'],
  } as any);

  let assigned = 0;
  let next = 1;
  for (const row of Array.isArray(rows) ? rows : []) {
    const documentId = String((row as any)?.documentId ?? '').trim();
    if (!documentId) continue;
    const listingNo = next;
    next += 1;
    await strapi.db.query(LISTING_UID).updateMany({
      where: { documentId },
      data: { listingNo },
    } as any);
    assigned += 1;
  }

  await appStore.set({ key, value: true });
  strapi.log.info(
    `Listing number backfill completed: assigned=${assigned} listing(s) sequential numbers 1..${assigned}.`,
  );
};
