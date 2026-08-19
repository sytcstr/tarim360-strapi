const LISTING_UID = 'api::listing.listing';
const OFFER_UID = 'api::offer.offer';
const COMMENT_UID = 'api::listing-comment.listing-comment';
const SHARE_UID = 'api::listing-share.listing-share';

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
