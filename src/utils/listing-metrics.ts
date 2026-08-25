const LISTING_UID = 'api::listing.listing';
const OFFER_UID = 'api::offer.offer';
const COMMENT_UID = 'api::listing-comment.listing-comment';
const SHARE_UID = 'api::listing-share.listing-share';
const PURCHASE_EVENT_UID = 'api::purchase-event.purchase-event';

/**
 * FINAL_R1_TARGETED_RELEASE_FIX_REPORT.md R1.2 (FINAL-BUG-002, HIGH):
 * mirrors lib/features/premium/premium_config.dart's kNormalListingFreeCount/
 * kNormalListingBlockSize and purchase_coordinator.dart's
 * PurchaseProductCatalog.normalListingQuota5. Shared between listing.ts's
 * own create() and engagement.ts's syncOfflineListing (the offline-queue
 * create path) -- both are real ways to create a listing row, so both
 * must enforce the same quota, exactly the same reasoning as
 * LISTING_CLIENT_PROTECTED_FIELDS above.
 */
export const NORMAL_LISTING_FREE_COUNT = 5;
export const NORMAL_LISTING_BLOCK_SIZE = 5;
export const NORMAL_LISTING_QUOTA_PRODUCT_ID = 'normal_listing_5_399';

/**
 * Server-authoritative mirror of NormalListingQuotaStatus.canCreateNext
 * (purchase_store.dart). `usedCount` counts real listing rows owned by
 * this profile (not a client-supplied count); `purchasedBlocks` counts
 * real, verified purchase-event rows for the quota product (not
 * client-trusted purchase history) -- both recomputed fresh from the DB
 * on every call. Callers are expected to skip this entirely for premium/
 * business-exempt owners (see isPremiumActiveFromProfile).
 */
export const canCreateNextNormalListing = async (
  strapi: any,
  ownerProfileId: string,
): Promise<boolean> => {
  // `listing` has draftAndPublish:true -- every real create leaves TWO
  // physical rows sharing one documentId (a draft, publishedAt:null, and
  // the published row that actually represents the listing). Counting
  // without this filter double-counts every real listing toward the
  // quota (confirmed live while writing this fix's own regression test:
  // a free-tier account was rejected on its 4th listing, not its 6th).
  const usedCount = await strapi.db.query(LISTING_UID).count({
    where: { ownerProfileId, publishedAt: { $notNull: true } },
  } as any);
  const purchasedBlocks = await strapi.db.query(PURCHASE_EVENT_UID).count({
    where: {
      ownerProfileId,
      productId: NORMAL_LISTING_QUOTA_PRODUCT_ID,
      status: 'verified',
    },
  } as any);
  const allowedCount =
    NORMAL_LISTING_FREE_COUNT + purchasedBlocks * NORMAL_LISTING_BLOCK_SIZE;
  return usedCount < allowedCount;
};

/**
 * LISTING_L3_LISTING_TYPE_AND_PUBLIC_NUMBER_REPORT.md L3.5: the smallest
 * safe server-authoritative scheme this DB/Strapi setup supports without a
 * new content-type or dialect-specific raw SQL sequence -- next number is
 * MAX(listingNo)+1 over published rows (see the draftAndPublish comment on
 * canCreateNextNormalListing for why published-only; a draft/published
 * pair sharing one create always gets the SAME listingNo value since it's
 * part of the one `data` object passed to entityService.create, so it
 * never inflates the max). The real concurrency guarantee is the
 * `listing_no` unique DB index (ensureListingNoUniqueIndex, src/index.ts) --
 * this function only picks a candidate; callers must retry with a freshly
 * computed candidate if the insert using it fails (mirrors the exact
 * try/catch-and-retry shape listing.ts's own create() already uses for its
 * operationId ledger claim race).
 */
export const nextListingNo = async (strapi: any): Promise<number> => {
  const rows = await strapi.db.query(LISTING_UID).findMany({
    where: { publishedAt: { $notNull: true } },
    orderBy: { listingNo: 'desc' },
    limit: 1,
    select: ['listingNo'],
  } as any);
  const current = Array.isArray(rows) && rows[0] ? Number(rows[0].listingNo) || 0 : 0;
  return current + 1;
};

type ListingCounterField =
  | 'viewCount'
  | 'favoriteCount'
  | 'likeCount'
  | 'offerCount'
  | 'commentCount'
  | 'shareCount';

const asString = (value: unknown): string => String(value ?? '').trim();

/**
 * LISTING_SYSTEM_RELEASE_FORENSIC_AUDIT.md BUG-LISTING-001/004: single
 * source of truth for which listing fields a client must never be able
 * to write directly, shared by listing.ts's own create/update guard and
 * by engagement.ts's syncOfflineListing (the offline-queue write path,
 * which previously bypassed this list entirely). Includes isDoping/
 * rocketEndsAt -- SEMANTIC_CONTRACT_S2's CLIENT_PROTECTED_FIELDS
 * deliberately excluded these ("a separate rocket/promotion mechanism,
 * not part of this audit item"), which meant any listing owner could
 * self-grant a free rocket/boost via a crafted PUT; closed here.
 */
export const LISTING_CLIENT_PROTECTED_FIELDS = [
  'likeCount',
  'favoriteCount',
  'viewCount',
  'offerCount',
  'commentCount',
  'shareCount',
  'engagementVersion',
  'isPremium',
  'isPremiumOwner',
  'isDoping',
  'rocketEndsAt',
  // LISTING_L3_LISTING_TYPE_AND_PUBLIC_NUMBER_REPORT.md L3.7: the
  // user-facing "T360-XXXXX" number is server-generated at create() and
  // must be immutable afterward -- a client sending its own listingNo
  // (create()'s previous behavior: the Flutter client sent a
  // timestamp-derived guess) must never overwrite another listing's real
  // number, on create, update, or the offline-sync equivalents of either.
  'listingNo',
] as const;

export const stripListingProtectedFields = (
  data: Record<string, any>,
): Record<string, any> => {
  const next = { ...data };
  for (const field of LISTING_CLIENT_PROTECTED_FIELDS) delete next[field];
  return next;
};

export const listingIdCandidates = (raw: unknown): string[] => {
  const id = asString(raw);
  if (!id) return [];
  const set = new Set<string>([id]);
  for (const prefix of ['strapi_', 'listing_']) {
    if (id.startsWith(prefix)) {
      const trimmed = id.slice(prefix.length).trim();
      if (trimmed) set.add(trimmed);
    }
  }
  const digit = id.match(/(\d+)/)?.[1];
  if (digit) set.add(digit);
  return [...set];
};

export const findListingByAnyId = async (
  strapi: any,
  rawId: unknown,
  fields: string[] = ['id', 'documentId', 'listingNo'],
) => {
  // PREMIUM_P1_TARGETED_FIX_REPORT.md: this content-type has
  // draftAndPublish:true, so entityService.create (even with publishedAt
  // set) leaves TWO physical rows sharing one documentId -- a draft
  // (publishedAt: null) and the published row callers actually mean
  // (confirmed live: entityService.create's own return value is the
  // published row, but a plain db.query by documentId with no further
  // filter can match either one, non-deterministically). Every db.query
  // fallback below must filter to the published row explicitly, or a
  // write can silently land on the invisible draft while every real
  // reader (the public API, entityService.findOne's own default) keeps
  // showing the unchanged published row.
  const PUBLISHED_ONLY = { publishedAt: { $notNull: true } };

  for (const id of listingIdCandidates(rawId)) {
    const numeric = Number(id);
    if (Number.isInteger(numeric) && numeric > 0) {
      try {
        const row = await strapi.entityService.findOne(
          LISTING_UID as any,
          numeric as any,
          { fields },
        );
        if (row) return row;
      } catch (_) {
        // continue
      }
      try {
        const row = await strapi.db.query(LISTING_UID).findOne({
          where: { id: numeric, ...PUBLISHED_ONLY },
          select: fields as any,
        } as any);
        if (row) return row;
      } catch (_) {
        // continue
      }
    }
    try {
      const row = await strapi.db.query(LISTING_UID).findOne({
        where: { documentId: id, ...PUBLISHED_ONLY },
      } as any);
      if (row) return row;
    } catch (_) {
      // continue
    }
    if (Number.isInteger(numeric) && numeric > 0) {
      try {
        const row = await strapi.db.query(LISTING_UID).findOne({
          where: { listingNo: numeric, ...PUBLISHED_ONLY },
        } as any);
        if (row) return row;
      } catch (_) {
        // continue
      }
    }
  }
  return null;
};

export const setListingCounter = async (
  strapi: any,
  rawListingId: unknown,
  field: ListingCounterField,
  value: number,
): Promise<void> => {
  const listing = await findListingByAnyId(strapi, rawListingId, [
    'id',
    'documentId',
    'listingNo',
    field,
  ]);
  if (!listing?.id) return;
  await strapi.entityService.update(LISTING_UID as any, listing.id as any, {
    data: { [field]: Math.max(0, Number(value) || 0) } as any,
  });
};

const rowsForListing = async (
  strapi: any,
  uid: string,
  rawListingId: unknown,
  fields: string[],
) => {
  const candidates = listingIdCandidates(rawListingId);
  if (candidates.length === 0) return [];
  const rows = await strapi.entityService.findMany(uid as any, {
    filters: { listingId: { $in: candidates } },
    fields,
    limit: 1000,
  } as any);
  return Array.isArray(rows) ? rows : rows ? [rows] : [];
};

export const recountListingOffers = async (
  strapi: any,
  rawListingId: unknown,
): Promise<number> => {
  const rows = await rowsForListing(strapi, OFFER_UID, rawListingId, ['id']);
  await setListingCounter(strapi, rawListingId, 'offerCount', rows.length);
  return rows.length;
};

export const recountListingComments = async (
  strapi: any,
  rawListingId: unknown,
): Promise<number> => {
  const rows = await rowsForListing(strapi, COMMENT_UID, rawListingId, [
    'id',
    'isDeleted',
  ]);
  const count = rows.filter((row: any) => row?.isDeleted !== true).length;
  await setListingCounter(strapi, rawListingId, 'commentCount', count);
  return count;
};

export const recountListingShares = async (
  strapi: any,
  rawListingId: unknown,
): Promise<number> => {
  const rows = await rowsForListing(strapi, SHARE_UID, rawListingId, ['id']);
  await setListingCounter(strapi, rawListingId, 'shareCount', rows.length);
  return rows.length;
};
