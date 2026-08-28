import { normalizeTurkishText } from './listing-search-fields';

/**
 * LISTING_L6_SERVER_SEARCH_FILTER_SORT_REPORT.md L6.2/L6.14: the
 * canonical, whitelisted listing-discovery query contract. `listing.ts`'s
 * `find()` was previously unoverridden (vanilla core `find`, whatever
 * `ctx.query` the client sent went straight to the DB) -- correct, but
 * with zero protection against a client sending arbitrary Strapi filter/
 * sort operators (e.g. `filters[ownerEmail][$ne]=` to enumerate a private
 * field, or a `sort` on an unindexed/unexpected column). This module is
 * pure and framework-free on purpose: given a raw query object, it either
 * returns `null` (none of the new-contract param names are present --
 * the caller should fall through to the plain, unmodified core `find`,
 * preserving every existing/legacy raw-filter call byte-for-byte) or a
 * fully-built, safe `{filters, sort, pagination}` object built ONLY from
 * whitelisted field names/operators -- any raw `filters[...]`/`sort` the
 * client also sent in the same request is deliberately ignored, never
 * merged, so the two styles can't be combined to smuggle an
 * unwhitelisted expression through.
 */

export const LISTING_DISCOVERY_PARAM_KEYS = [
  'search',
  'listingNo',
  'mainType',
  'subType',
  'mode',
  'city',
  'district',
  'minPrice',
  'maxPrice',
  'sortBy',
  'page',
  'pageSize',
] as const;

export const LISTING_SORT_WHITELIST = [
  'newest',
  'oldest',
  'price_asc',
  'price_desc',
  'popular',
] as const;
export type ListingSortBy = (typeof LISTING_SORT_WHITELIST)[number];

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

const asTrimmedString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const asPositiveInt = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

const asFiniteNumber = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export const hasAnyListingDiscoveryParam = (
  rawQuery: Record<string, unknown>,
): boolean =>
  LISTING_DISCOVERY_PARAM_KEYS.some(
    (key) => rawQuery[key] !== undefined && rawQuery[key] !== null && rawQuery[key] !== '',
  );

export type ListingDiscoveryQuery = {
  filters: Record<string, unknown>;
  sort: Array<Record<string, 'asc' | 'desc'>>;
  pagination: { page: number; pageSize: number };
  // LISTING_L12_POPULAR_TRENDING_RANKING_REPORT.md L12.4: the resolved
  // sortBy is exposed here so the controller can detect `'popular'` and
  // route to the dedicated two-tier composite query (listing-popular-
  // query.ts) instead of passing `sort` straight through to the generic
  // entityService find -- a plain field-direction sort array cannot
  // express "active (non-expired) Rocket listings first", which needs a
  // live rocketEndsAt-vs-now comparison, not a static column value.
  sortBy: ListingSortBy;
};

/**
 * Returns `null` when no new-contract param is present (caller should not
 * touch the request at all). Otherwise builds a safe filters/sort/
 * pagination object. `minPrice > maxPrice` is treated as an always-empty
 * result (an impossible range) rather than a 400 -- consistent with how
 * an ordinary "no matches" search behaves, and avoids the client having
 * to special-case a user who just fat-fingered the two fields.
 */
export const buildListingDiscoveryQuery = (
  rawQuery: Record<string, unknown>,
): ListingDiscoveryQuery | null => {
  if (!hasAnyListingDiscoveryParam(rawQuery)) return null;

  const filters: Record<string, unknown> = { status: { $eq: 'active' } };

  const listingNo = asPositiveInt(rawQuery.listingNo);
  if (listingNo !== null) {
    filters.listingNo = { $eq: listingNo };
  } else {
    const search = asTrimmedString(rawQuery.search);
    if (search) {
      filters.searchNormalized = { $containsi: normalizeTurkishText(search) };
    }
  }

  const mainType = asTrimmedString(rawQuery.mainType);
  if (mainType) filters.mainType = { $eq: mainType };

  const subType = asTrimmedString(rawQuery.subType);
  if (subType) filters.subType = { $eq: subType };

  const mode = asTrimmedString(rawQuery.mode).toLowerCase();
  if (mode === 'sell' || mode === 'buy') filters.mode = { $eq: mode };

  const city = asTrimmedString(rawQuery.city);
  if (city) filters.cityNormalized = { $eq: normalizeTurkishText(city) };

  const district = asTrimmedString(rawQuery.district);
  if (district) {
    filters.district = { $containsi: district };
  }

  const minPrice = asFiniteNumber(rawQuery.minPrice);
  const maxPrice = asFiniteNumber(rawQuery.maxPrice);
  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) {
    // Impossible range -- force a guaranteed-empty result rather than
    // silently ignoring one bound or guessing which one the caller meant.
    filters.price = { $eq: -1 };
  } else {
    const priceFilter: Record<string, number> = {};
    if (minPrice !== null) priceFilter.$gte = minPrice;
    if (maxPrice !== null) priceFilter.$lte = maxPrice;
    if (Object.keys(priceFilter).length > 0) filters.price = priceFilter;
  }

  const sortByRaw = asTrimmedString(rawQuery.sortBy).toLowerCase();
  const sortBy: ListingSortBy = (
    LISTING_SORT_WHITELIST as readonly string[]
  ).includes(sortByRaw)
    ? (sortByRaw as ListingSortBy)
    : 'newest';
  // A deterministic secondary sort (`id`) breaks ties for equal price/date
  // -- without it, two listings priced identically could swap order
  // between identical requests/pages, which would make "page 2" show a
  // row already seen on "page 1" or skip one entirely.
  const sort: Array<Record<string, 'asc' | 'desc'>> = (() => {
    switch (sortBy) {
      case 'oldest':
        return [{ createdAt: 'asc' }, { id: 'asc' }];
      case 'price_asc':
        return [{ price: 'asc' }, { id: 'asc' }];
      case 'price_desc':
        return [{ price: 'desc' }, { id: 'asc' }];
      case 'popular':
        // Never actually used -- the controller branches to
        // listing-popular-query.ts before consulting `.sort` for this
        // sortBy value. Kept as an inert, sensible fallback only so this
        // field's type stays a plain non-nullable array.
        return [{ createdAt: 'desc' }, { id: 'desc' }];
      case 'newest':
      default:
        return [{ createdAt: 'desc' }, { id: 'desc' }];
    }
  })();

  const pageRaw = asPositiveInt(rawQuery.page);
  const page = pageRaw ?? 1;
  const pageSizeRaw = asPositiveInt(rawQuery.pageSize);
  const pageSize = Math.min(pageSizeRaw ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  return { filters, sort, pagination: { page, pageSize }, sortBy };
};
