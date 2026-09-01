import type { Core } from '@strapi/strapi';
import { PUBLISHED_ONLY_FILTER } from './listing-metrics';

const LISTING_UID = 'api::listing.listing';

/**
 * LISTING_L19_MARKETPLACE_PRODUCT_GAP_FOUNDATIONS_REPORT.md L19.9-L19.17.
 *
 * Forensic found NO similarity logic anywhere (backend or Flutter) before
 * this phase. This is deliberately NOT a recommendation/ML engine --
 * a single bounded, DB-filtered candidate query (same "bounded candidate
 * query" shape as listing-popular-query.ts) followed by an in-Node,
 * fully deterministic relevance score over that bounded set.
 *
 * Candidate pool is bounded by two INDEXED columns (mainType, and mode
 * when applicable) plus the always-present status filter -- never a
 * full-table scan. CANDIDATE_BOUND caps how many rows are ever pulled
 * into Node for scoring, so this stays cheap even if a single mainType
 * has tens of thousands of active listings.
 *
 * Scoring (deliberately simple, integer, and fully explained -- no
 * invented percentage-based weighting scheme):
 *   +2  same subType
 *   +1  same cityNormalized
 *   +1  price within PRICE_PROXIMITY_RATIO of the reference listing's
 *       price (only when BOTH prices are finite and > 0 -- an
 *       offer-based/"Teklif usulu" or buy-mode listing with no fixed
 *       price never contributes or receives this bonus, it's simply
 *       absent, never treated as a mismatch)
 * Ties are broken by createdAt desc, then id desc -- both deterministic,
 * so identical requests against an unchanged dataset always return rows
 * in the same order (L19.12).
 *
 * L19.14 PRODUCT DECISION (not a silent choice): `mode` is applied as a
 * hard filter, not a scoring signal -- a sell listing's "similar" set is
 * only ever other sell listings, and a buy listing's only ever other buy
 * listings. Mixing the two would show a buyer's "wanted: wheat" post as
 * "similar" to a seller's "selling wheat" listing, which is not a
 * genuine similarity in this marketplace's semantics. Flagged here as an
 * explicit, reportable decision per the mandate, not an invented default.
 */

const CANDIDATE_BOUND = 60;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 20;
const PRICE_PROXIMITY_RATIO = 0.25;
const SUBTYPE_MATCH_SCORE = 2;
const CITY_MATCH_SCORE = 1;
const PRICE_PROXIMITY_SCORE = 1;

export type SimilarListingReference = {
  listingNo: number | null;
  mainType: string | null;
  subType: string | null;
  cityNormalized: string | null;
  price: number | null;
  mode: string | null;
};

export type SimilarListingsPage = {
  results: Record<string, unknown>[];
  // `total` is the size of the bounded candidate pool actually
  // considered (max CANDIDATE_BOUND), NOT a true full-catalog count --
  // this is a bounded relevance feed, not a deep-paginated search; a
  // caller wanting "all listings like this one" should use the plain
  // discovery contract (mainType/subType/city filters) instead.
  pagination: { page: number; pageSize: number; total: number };
};

const asFiniteNumber = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export const fetchSimilarListingsPage = async (
  strapi: Core.Strapi,
  reference: SimilarListingReference,
  page: number,
  pageSize: number,
): Promise<SimilarListingsPage> => {
  const safePageSize = Math.min(
    Math.max(1, Number.isFinite(pageSize) ? pageSize : DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );
  const safePage = Math.max(1, Number.isFinite(page) ? page : 1);

  const mainType = (reference.mainType ?? '').trim();
  if (!mainType) {
    return {
      results: [],
      pagination: { page: safePage, pageSize: safePageSize, total: 0 },
    };
  }

  const where: Record<string, unknown> = {
    ...PUBLISHED_ONLY_FILTER,
    status: { $eq: 'active' },
    mainType: { $eq: mainType },
  };
  if (reference.mode === 'sell' || reference.mode === 'buy') {
    where.mode = { $eq: reference.mode };
  }
  if (reference.listingNo !== null && reference.listingNo !== undefined) {
    where.listingNo = { $ne: reference.listingNo };
  }

  const candidates = await strapi.db.query(LISTING_UID).findMany({
    where: where as any,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] as any,
    limit: CANDIDATE_BOUND,
  });
  const rows: any[] = Array.isArray(candidates) ? candidates : [];

  const refSubType = (reference.subType ?? '').trim();
  const refCity = (reference.cityNormalized ?? '').trim();
  const refPrice = asFiniteNumber(reference.price);

  const scored = rows.map((row) => {
    let score = 0;
    if (refSubType && row.subType && row.subType === refSubType) {
      score += SUBTYPE_MATCH_SCORE;
    }
    if (refCity && row.cityNormalized && row.cityNormalized === refCity) {
      score += CITY_MATCH_SCORE;
    }
    if (refPrice !== null && refPrice > 0) {
      const rowPrice = asFiniteNumber(row.price);
      if (rowPrice !== null && rowPrice > 0) {
        const ratio = Math.abs(rowPrice - refPrice) / refPrice;
        if (ratio <= PRICE_PROXIMITY_RATIO) score += PRICE_PROXIMITY_SCORE;
      }
    }
    return { row, score };
  });

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aCreated = new Date(a.row.createdAt ?? 0).getTime();
    const bCreated = new Date(b.row.createdAt ?? 0).getTime();
    if (bCreated !== aCreated) return bCreated - aCreated;
    return Number(b.row.id ?? 0) - Number(a.row.id ?? 0);
  });

  const total = scored.length;
  const offset = (safePage - 1) * safePageSize;
  const pageRows = scored
    .slice(offset, offset + safePageSize)
    .map((s) => s.row);

  // `ownerEmail` is the one `private:true` field on this content-type --
  // db.query bypasses entityService's role-based stripping entirely (same
  // confirmed-live finding listing-popular-query.ts's own comment
  // documents), so it must be stripped by hand here too.
  const publicRows = pageRows.map(({ ownerEmail: _ownerEmail, ...rest }) => rest);

  return {
    results: publicRows,
    pagination: { page: safePage, pageSize: safePageSize, total },
  };
};
