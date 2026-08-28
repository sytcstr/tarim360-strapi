import type { Core } from '@strapi/strapi';

const LISTING_UID = 'api::listing.listing';

/**
 * LISTING_L12_POPULAR_TRENDING_RANKING_REPORT.md L12.3/L12.4/L12.6/L12.15.
 *
 * Forensic found NO server-side "Popular" ranking existed anywhere before
 * this phase -- `LISTING_SORT_WHITELIST` only had newest/oldest/price_*,
 * and every "Popular"/"Trending" screen in Flutter computed its own order
 * in Dart over whatever ~60 most-recent listings happened to already be
 * cached client-side. At real catalog scale (thousands of listings) that
 * is not a global ranking at all -- it can only ever reflect a small
 * recency-biased window, never "the most popular listing in the whole
 * pool". This module makes Popular ordering server-authoritative over the
 * FULL eligible catalog instead.
 *
 * Canonical formula, DELIBERATELY not a new invention: Home's and the
 * Popular page's own (until now client-side, non-drifted, identical
 * between the two files) formula was `rocketBoost + views + favorites*6
 * + offers*8 + likes*4`, where rocketBoost (100000) and premiumBoost
 * (12000) so dominate any realistic engagement sum that the formula is
 * EFFECTIVELY a three-tier ordering in practice: active-Rocket listings
 * first, then premium-owner listings, then everyone else, each tier
 * internally ordered by engagement. This module reproduces exactly that
 * tiering, using the same relative weight importance (offers heaviest,
 * then favorites, then likes, then views) as sequential tie-break sort
 * keys rather than a literal weighted sum -- see the report's L12.3
 * PRODUCT DECISION note on why a true weighted-sum composite would
 * require either raw SQL or a new persisted score column, neither of
 * which was justified by a demonstrated need (L12.16).
 *
 * Two real DB queries (never a raw/full-table scan), each bounded by
 * `limit`, composed in Node -- this is the "bounded candidate query"
 * option L12.15 itself suggests when a single declarative sort can't
 * express the ranking. Tier 1 requires a live `rocketEndsAt > now`
 * comparison (a static column-direction sort cannot express "only
 * while still active", the exact bug L12.6 warns against: an expired
 * rocket must NEVER float above non-rocketed listings just because its
 * `isDoping` column is still stale-true at the DB row level -- L10's own
 * read-time correction only fixes what's *served*, not what a query
 * *orders by*).
 */

const ENGAGEMENT_TIEBREAK_SORT = [
  { offerCount: 'desc' },
  { favoriteCount: 'desc' },
  { likeCount: 'desc' },
  { viewCount: 'desc' },
  { createdAt: 'desc' },
  { id: 'desc' },
] as const;

const TIER2_SORT = [
  { isPremiumOwner: 'desc' },
  ...ENGAGEMENT_TIEBREAK_SORT,
] as const;

export type PopularListingsPage = {
  results: Record<string, unknown>[];
  pagination: { page: number; pageSize: number; pageCount: number; total: number };
};

/**
 * `baseFilters` is whatever `buildListingDiscoveryQuery` already built
 * from mainType/subType/mode/city/district/search/price/status --
 * reused as-is so popular ordering respects the exact same eligibility
 * and filter contract as every other sort mode, never a separate/looser
 * one.
 */
export const fetchPopularListingsPage = async (
  strapi: Core.Strapi,
  baseFilters: Record<string, unknown>,
  page: number,
  pageSize: number,
): Promise<PopularListingsPage> => {
  const nowIso = new Date().toISOString();

  // `listing` has draftAndPublish:true -- every real create leaves TWO
  // physical rows sharing one documentId (a draft, publishedAt:null,
  // and the published row). Without this filter both tiers would
  // return each listing twice. Matches the same published-only
  // filtering `resolveTargetRow`/other listing queries already use.
  const publishedOnly = { publishedAt: { $notNull: true } };

  const tier1Filters = {
    ...baseFilters,
    ...publishedOnly,
    isDoping: { $eq: true },
    rocketEndsAt: { $gt: nowIso },
  };
  const tier2Filters = {
    ...baseFilters,
    ...publishedOnly,
    $or: [
      { isDoping: { $eq: false } },
      { isDoping: { $null: true } },
      { rocketEndsAt: { $lte: nowIso } },
      { rocketEndsAt: { $null: true } },
    ],
  };

  const [tier1Count, tier2Count] = await Promise.all([
    strapi.db.query(LISTING_UID).count({ where: tier1Filters as any }),
    strapi.db.query(LISTING_UID).count({ where: tier2Filters as any }),
  ]);
  const total = tier1Count + tier2Count;

  const globalOffset = (page - 1) * pageSize;
  let tier1Rows: Record<string, unknown>[] = [];
  let tier2Rows: Record<string, unknown>[] = [];

  if (globalOffset < tier1Count) {
    const tier1Take = Math.min(pageSize, tier1Count - globalOffset);
    tier1Rows = await strapi.db.query(LISTING_UID).findMany({
      where: tier1Filters as any,
      orderBy: ENGAGEMENT_TIEBREAK_SORT as any,
      offset: globalOffset,
      limit: tier1Take,
    });
    if (tier1Take < pageSize) {
      tier2Rows = await strapi.db.query(LISTING_UID).findMany({
        where: tier2Filters as any,
        orderBy: TIER2_SORT as any,
        offset: 0,
        limit: pageSize - tier1Take,
      });
    }
  } else {
    const tier2Offset = globalOffset - tier1Count;
    tier2Rows = await strapi.db.query(LISTING_UID).findMany({
      where: tier2Filters as any,
      orderBy: TIER2_SORT as any,
      offset: tier2Offset,
      limit: pageSize,
    });
  }

  return {
    results: [...tier1Rows, ...tier2Rows],
    pagination: {
      page,
      pageSize,
      pageCount: Math.max(1, Math.ceil(total / pageSize)),
      total,
    },
  };
};
