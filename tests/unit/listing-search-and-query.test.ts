/**
 * LISTING_L6_SERVER_SEARCH_FILTER_SORT_REPORT.md — pure-function unit
 * tests for src/utils/listing-search-fields.ts and
 * src/utils/listing-query.ts, no Strapi boot required. The real DB-level
 * behavior (filters actually applied at the query level, before
 * pagination) is covered by
 * tests/integration/listing-search-filter-sort.integration.test.ts; this
 * file is about the pure logic in isolation -- Turkish normalization
 * folding, city/district extraction, and the whitelist/passthrough
 * decision.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeListingSearchFields,
  normalizeTurkishText,
} from '../../src/utils/listing-search-fields.ts';
import {
  buildListingDiscoveryQuery,
  hasAnyListingDiscoveryParam,
} from '../../src/utils/listing-query.ts';

test('normalizeTurkishText folds case and diacritics to a canonical ASCII form', () => {
  assert.equal(normalizeTurkishText('İzmir'), 'izmir');
  assert.equal(normalizeTurkishText('IZMIR'), 'izmir');
  assert.equal(normalizeTurkishText('izmir'), 'izmir');
  assert.equal(normalizeTurkishText('Çiftçi'), 'ciftci');
  assert.equal(normalizeTurkishText('Şanlıurfa'), 'sanliurfa');
  assert.equal(normalizeTurkishText('Buğday Ürünü'), 'bugday urunu');
});

test('normalizeTurkishText collapses punctuation/whitespace and trims', () => {
  assert.equal(normalizeTurkishText('  Konya,  Selçuklu!  '), 'konya selcuklu');
});

test('normalizeTurkishText never throws on null/undefined/non-string input', () => {
  assert.equal(normalizeTurkishText(null), '');
  assert.equal(normalizeTurkishText(undefined), '');
  assert.equal(normalizeTurkishText(12345), '12345');
});

test('computeListingSearchFields extracts city/district from a structured location object', () => {
  const result = computeListingSearchFields({
    title: 'Test',
    description: '',
    mainType: 'tarim',
    subType: '',
    location: { city: 'Şanlıurfa', district: 'Haliliye', display: 'Şanlıurfa' },
  });
  assert.equal(result.city, 'Şanlıurfa');
  assert.equal(result.district, 'Haliliye');
  assert.equal(result.cityNormalized, 'sanliurfa');
});

test('computeListingSearchFields falls back to ownerCity when location has no city', () => {
  const result = computeListingSearchFields({
    location: 'a plain legacy string, not an object',
    ownerCity: 'Konya',
  });
  assert.equal(result.city, 'Konya');
  assert.equal(result.cityNormalized, 'konya');
  assert.equal(result.district, null);
});

test('computeListingSearchFields returns nulls (not empty strings) when there is no city at all', () => {
  const result = computeListingSearchFields({ title: 'x' });
  assert.equal(result.city, null);
  assert.equal(result.district, null);
  assert.equal(result.cityNormalized, null);
});

test('computeListingSearchFields folds title+description+mainType+subType+city into searchNormalized', () => {
  const result = computeListingSearchFields({
    title: 'Buğday',
    description: 'Çiftçi ürünü',
    mainType: 'tarim',
    subType: 'Tahıllar',
    location: { city: 'İzmir' },
  });
  assert.ok(result.searchNormalized.includes('bugday'));
  assert.ok(result.searchNormalized.includes('ciftci urunu'));
  assert.ok(result.searchNormalized.includes('tahillar'));
  assert.ok(result.searchNormalized.includes('izmir'));
});

test('hasAnyListingDiscoveryParam is false for an empty/legacy query', () => {
  assert.equal(hasAnyListingDiscoveryParam({}), false);
  assert.equal(
    hasAnyListingDiscoveryParam({ 'filters[mode][$eq]': 'sell', sort: 'createdAt:desc' }),
    false,
  );
});

test('hasAnyListingDiscoveryParam is true when any single new param is present', () => {
  assert.equal(hasAnyListingDiscoveryParam({ search: 'x' }), true);
  assert.equal(hasAnyListingDiscoveryParam({ sortBy: 'price_asc' }), true);
  assert.equal(hasAnyListingDiscoveryParam({ page: '2' }), true);
});

test('buildListingDiscoveryQuery returns null for a legacy/empty query (passthrough signal)', () => {
  assert.equal(buildListingDiscoveryQuery({}), null);
  assert.equal(buildListingDiscoveryQuery({ 'filters[mode][$eq]': 'sell' }), null);
});

test('buildListingDiscoveryQuery always scopes to status=active', () => {
  const q = buildListingDiscoveryQuery({ search: 'x' });
  assert.deepEqual(q?.filters.status, { $eq: 'active' });
});

test('buildListingDiscoveryQuery: listingNo takes priority over search text', () => {
  const q = buildListingDiscoveryQuery({ listingNo: '42', search: 'ignored' });
  assert.deepEqual(q?.filters.listingNo, { $eq: 42 });
  assert.equal(q?.filters.searchNormalized, undefined);
});

test('buildListingDiscoveryQuery: search is Turkish-normalized before filtering', () => {
  const q = buildListingDiscoveryQuery({ search: 'Çiftçi' });
  assert.deepEqual(q?.filters.searchNormalized, { $containsi: 'ciftci' });
});

test('buildListingDiscoveryQuery: mode only accepts sell/buy, anything else is ignored', () => {
  assert.deepEqual(buildListingDiscoveryQuery({ mode: 'sell', page: '1' })?.filters.mode, {
    $eq: 'sell',
  });
  assert.equal(buildListingDiscoveryQuery({ mode: 'anything_else', page: '1' })?.filters.mode, undefined);
});

test('buildListingDiscoveryQuery: city filter is normalized', () => {
  const q = buildListingDiscoveryQuery({ city: 'İZMİR' });
  assert.deepEqual(q?.filters.cityNormalized, { $eq: 'izmir' });
});

test('buildListingDiscoveryQuery: price range boundaries build $gte/$lte correctly', () => {
  assert.deepEqual(buildListingDiscoveryQuery({ minPrice: '100', page: '1' })?.filters.price, {
    $gte: 100,
  });
  assert.deepEqual(buildListingDiscoveryQuery({ maxPrice: '300', page: '1' })?.filters.price, {
    $lte: 300,
  });
  assert.deepEqual(
    buildListingDiscoveryQuery({ minPrice: '100', maxPrice: '300', page: '1' })?.filters.price,
    { $gte: 100, $lte: 300 },
  );
});

test('buildListingDiscoveryQuery: min > max forces an impossible (always-empty) filter', () => {
  const q = buildListingDiscoveryQuery({ minPrice: '500', maxPrice: '100', page: '1' });
  assert.deepEqual(q?.filters.price, { $eq: -1 });
});

test('buildListingDiscoveryQuery: invalid numeric price params are silently ignored, not an error', () => {
  const q = buildListingDiscoveryQuery({ minPrice: 'abc', maxPrice: 'xyz', page: '1' });
  assert.equal(q?.filters.price, undefined);
});

test('buildListingDiscoveryQuery: sortBy whitelist maps to the right sort array with a deterministic secondary key', () => {
  assert.deepEqual(buildListingDiscoveryQuery({ sortBy: 'newest', page: '1' })?.sort, [
    { createdAt: 'desc' },
    { id: 'desc' },
  ]);
  assert.deepEqual(buildListingDiscoveryQuery({ sortBy: 'oldest', page: '1' })?.sort, [
    { createdAt: 'asc' },
    { id: 'asc' },
  ]);
  assert.deepEqual(buildListingDiscoveryQuery({ sortBy: 'price_asc', page: '1' })?.sort, [
    { price: 'asc' },
    { id: 'asc' },
  ]);
  assert.deepEqual(buildListingDiscoveryQuery({ sortBy: 'price_desc', page: '1' })?.sort, [
    { price: 'desc' },
    { id: 'asc' },
  ]);
});

test('buildListingDiscoveryQuery: sortBy=popular resolves and is exposed for the controller to detect (L12.4)', () => {
  const q = buildListingDiscoveryQuery({ sortBy: 'popular', page: '1' });
  assert.equal(q?.sortBy, 'popular');
  // The `.sort` field is never actually consulted for this sortBy value
  // (listing.ts's find() branches to listing-popular-query.ts instead)
  // but must still resolve to a valid, non-throwing fallback array.
  assert.ok(Array.isArray(q?.sort) && q!.sort.length > 0);
});

test('buildListingDiscoveryQuery: an unrecognized sortBy value falls back to newest', () => {
  const q = buildListingDiscoveryQuery({ sortBy: 'literally_anything', page: '1' });
  assert.deepEqual(q?.sort, [{ createdAt: 'desc' }, { id: 'desc' }]);
});

test('buildListingDiscoveryQuery: pageSize is capped at 50 and defaults to 20', () => {
  assert.equal(buildListingDiscoveryQuery({ page: '1' })?.pagination.pageSize, 20);
  assert.equal(
    buildListingDiscoveryQuery({ page: '1', pageSize: '999999' })?.pagination.pageSize,
    50,
  );
  assert.equal(buildListingDiscoveryQuery({ page: '1', pageSize: '10' })?.pagination.pageSize, 10);
});

test('buildListingDiscoveryQuery: page defaults to 1 and ignores non-positive values', () => {
  assert.equal(buildListingDiscoveryQuery({ search: 'x' })?.pagination.page, 1);
  assert.equal(buildListingDiscoveryQuery({ search: 'x', page: '0' })?.pagination.page, 1);
  assert.equal(buildListingDiscoveryQuery({ search: 'x', page: '3' })?.pagination.page, 3);
});
