/**
 * LISTING_L6_SERVER_SEARCH_FILTER_SORT_REPORT.md L6.4/L6.7: the listing
 * schema has no dedicated searchable "city" field -- only the freeform
 * `location` JSON blob (`{city, district, display}`, populated by the
 * client's fixed il/ilce picker) and `ownerCity` (the owner's profile
 * city, not necessarily the listing's own location). JSON-field querying
 * is inconsistent across Strapi's supported DB engines (SQLite in dev/
 * test vs Postgres in production -- see config/database.ts), so it isn't
 * a safe basis for a server-side filter/index. `city`/`district` are
 * promoted here to real top-level string columns, derived server-side
 * from `location` at create/update time (mirroring the listingNo
 * server-authoritative pattern) -- the client's create/update payload
 * shape is unchanged.
 *
 * `cityNormalized`/`searchNormalized` fold Turkish case/diacritics
 * (ciftci<->ciftci, izmir<->Izmir<->IZMIR, sanliurfa<->Sanliurfa) so
 * search/city filtering isn't defeated by a user or a legacy client
 * typing/sending a different casing than what was stored. Both are
 * write-only/internal: never displayed, only ever compared against.
 */

const TURKISH_CHAR_MAP: Array<[RegExp, string]> = [
  [/Ç/g, 'c'],
  [/ç/g, 'c'],
  [/Ğ/g, 'g'],
  [/ğ/g, 'g'],
  [/İ/g, 'i'],
  [/I/g, 'i'],
  [/ı/g, 'i'],
  [/Ö/g, 'o'],
  [/ö/g, 'o'],
  [/Ş/g, 's'],
  [/ş/g, 's'],
  [/Ü/g, 'u'],
  [/ü/g, 'u'],
];

/**
 * Deterministic, locale-independent Turkish text normalizer: folds
 * Turkish-specific letters (both cases, including the dotted/dotless
 * İ/I/ı confusion) to their plain-ASCII equivalent BEFORE any generic
 * lowercasing -- calling `.toLowerCase()` on 'İ' directly (without this
 * pre-fold) produces a combining-dot sequence ("i̇") on some JS engines,
 * which would silently break equality/contains comparisons against a
 * plain "i". Strips anything left that isn't a-z/0-9/whitespace and
 * collapses whitespace, so punctuation/extra spaces never cause a
 * false mismatch either.
 */
export const normalizeTurkishText = (value: unknown): string => {
  let text = String(value ?? '');
  for (const [pattern, replacement] of TURKISH_CHAR_MAP) {
    text = text.replace(pattern, replacement);
  }
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const asPlainString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const extractLocationField = (
  location: unknown,
  key: 'city' | 'district',
): string => {
  if (location && typeof location === 'object' && !Array.isArray(location)) {
    return asPlainString((location as Record<string, unknown>)[key]);
  }
  return '';
};

export type ListingSearchFieldsInput = {
  title?: unknown;
  description?: unknown;
  mainType?: unknown;
  subType?: unknown;
  location?: unknown;
  ownerCity?: unknown;
};

export type ListingSearchFields = {
  city: string | null;
  district: string | null;
  cityNormalized: string | null;
  searchNormalized: string;
};

/**
 * Single source of truth for the derived search/filter fields, used by
 * both `create()` and `update()` so a listing's discoverability never
 * depends on which write path touched it last. Callers pass the FULLY
 * MERGED state (existing row's stored values overridden by whatever
 * fields this write actually changes) -- editing only the title, for
 * example, must recompute `searchNormalized` with the new title while
 * preserving the listing's already-set city/district untouched, exactly
 * like L1's edit-hydration rule for category fields.
 */
export const computeListingSearchFields = (
  merged: ListingSearchFieldsInput,
): ListingSearchFields => {
  const city =
    extractLocationField(merged.location, 'city') ||
    asPlainString(merged.ownerCity);
  const district = extractLocationField(merged.location, 'district');
  const cityNormalized = city ? normalizeTurkishText(city) : '';
  const searchNormalized = normalizeTurkishText(
    [
      asPlainString(merged.title),
      asPlainString(merged.description),
      asPlainString(merged.mainType),
      asPlainString(merged.subType),
      city,
    ].join(' '),
  );
  return {
    city: city || null,
    district: district || null,
    cityNormalized: cityNormalized || null,
    searchNormalized,
  };
};
