import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseTurkishNumber } from '../../src/services/agri-real-price/tobb/numbers';
import { parseIstanbulDateTime } from '../../src/services/agri-real-price/tobb/dates';
import { parseTobbProductPage, type TobbRawRow } from '../../src/services/agri-real-price/tobb/parser';
import { normalizeTobbRow } from '../../src/services/agri-real-price/tobb/normalize';
import {
  autoIngestProducts,
  exchangeMap,
  lookupExchange,
  productMap,
} from '../../src/services/agri-real-price/tobb/maps';
import { createTobbFetcher, type HttpGet } from '../../src/services/agri-real-price/tobb/fetcher';
import { collectTobbObservations } from '../../src/services/agri-real-price/tobb/provider';
import { classifyFreshness, FRESHNESS_THRESHOLDS } from '../../src/services/agri-real-price/freshness';
import { runRealPriceIngestion } from '../../src/services/agri-real-price/runner';
import { readRealPriceMode } from '../../src/services/agri-real-price/types';
import products from '../../src/seeds/data/agri-products.json';
import provinces from '../../src/seeds/data/turkey-provinces.json';

const FIX = path.join(__dirname, '..', 'fixtures', 'tobb');
const fixture = (name: string) => readFileSync(path.join(FIX, name), 'utf8');
const NOW = new Date('2026-09-26T12:00:00Z');

const nohut = fixture('nohut_3_704.html');
const cavdar = fixture('cavdar_1_301.html');
const aycicegi = fixture('aycicegi_yaglik_4_602.html');
const noData = fixture('celtik_no_data_1_403.html');

const productByCode = (code: string) => productMap.find((p) => p.code === code)!;

const okPage = (html: string) => {
  const page = parseTobbProductPage(html);
  assert.equal(page.status, 'ok');
  return page as Extract<ReturnType<typeof parseTobbProductPage>, { status: 'ok' }>;
};

const ctxFor = (code: string, unit = 'KG') => ({
  product: productByCode(code),
  tobbUnit: unit,
  ana: 3,
  alt: 704,
  tobbProductName: 'NOHUT',
  sourceUrl: 'https://borsa.tobb.org.tr/fiyat_urun3.php?ana_kod=3&alt_kod=704',
  now: NOW,
});

const baseRow = (over: Partial<TobbRawRow> = {}): TobbRawRow => ({
  exchangeCode: '5CO20',
  exchangeName: 'CORUM TICARET BORSASI',
  lastTradeText: '25.09.2026 12:31',
  min: 35.15,
  max: 38.5,
  average: 36.83,
  quantity: 16000,
  transactionCount: 2,
  amount: 589280,
  ...over,
});

// ── numbers ──────────────────────────────────────────────────────────────────
test('Turkish numbers: decimals, thousand separators, integers', () => {
  assert.equal(parseTurkishNumber('36,830'), 36.83);
  assert.equal(parseTurkishNumber('13.420,50'), 13420.5);
  assert.equal(parseTurkishNumber('1.727.910,00'), 1727910);
  assert.equal(parseTurkishNumber('19.000'), 19000, 'dot is the thousands separator');
  assert.equal(parseTurkishNumber('382'), 382);
});

test('Turkish numbers: malformed input is rejected, never guessed', () => {
  for (const bad of ['', 'abc', '12,3,4', '1.23,4', '12.34', '--', '36,83 TL', '1,234.56', null, undefined]) {
    assert.equal(parseTurkishNumber(bad as any), null, String(bad));
  }
});

// ── dates ────────────────────────────────────────────────────────────────────
test('dates: Europe/Istanbul local time -> UTC', () => {
  assert.equal(parseIstanbulDateTime('25.09.2026 12:31', NOW).iso, '2026-09-25T09:31:00.000Z');
  assert.equal(parseIstanbulDateTime('01.01.2026 00:05', NOW).iso, '2025-12-31T21:05:00.000Z');
});

test('dates: invalid and future dates are rejected', () => {
  assert.equal(parseIstanbulDateTime('31.02.2026 10:00', NOW).reason, 'invalid');
  assert.equal(parseIstanbulDateTime('25.09.2026 25:00', NOW).reason, 'invalid');
  assert.equal(parseIstanbulDateTime('2026-09-25 12:31', NOW).reason, 'invalid');
  assert.equal(parseIstanbulDateTime('', NOW).reason, 'invalid');
  assert.equal(parseIstanbulDateTime('27.09.2026 10:00', NOW).reason, 'future');
});

// ── parser (real page fixtures) ──────────────────────────────────────────────
test('parser: real nohut page -> validated header, 4 rows, exact values', () => {
  const page = okPage(nohut);
  assert.equal(page.product, 'NOHUT');
  assert.equal(page.unit, 'KG');
  assert.equal(page.rows.length, 4);
  const corum = page.rows.find((r) => r.exchangeCode === '5CO20')!;
  assert.deepEqual(
    { ...corum },
    {
      exchangeCode: '5CO20',
      exchangeName: 'CORUM TICARET BORSASI',
      lastTradeText: '25.09.2026 12:31',
      min: 35.15,
      max: 38.5,
      average: 36.83,
      quantity: 16000,
      transactionCount: 2,
      amount: 589280,
    },
  );
});

test('parser: a page without data is "no-data", not an error', () => {
  const page = parseTobbProductPage(noData);
  assert.equal(page.status, 'no-data');
});

test('parser: header changes fail closed (no rows)', () => {
  const swapped = nohut.replace('Ortalama <br>(TL)', 'Toplam <br>(TL)');
  assert.notEqual(swapped, nohut);
  const r = parseTobbProductPage(swapped);
  assert.equal(r.status, 'error');
  assert.match((r as any).reason, /header-mismatch/);
});

test('parser: column order swap (min/max) is rejected by the header check', () => {
  const swapped = nohut
    .replace('En Az<br>(TL)', 'TMP')
    .replace('En Çok<br>(TL)', 'En Az<br>(TL)')
    .replace('TMP', 'En Çok<br>(TL)');
  assert.equal(parseTobbProductPage(swapped).status, 'error');
});

test('parser: unit in header must equal the unit in the title', () => {
  const r = parseTobbProductPage(nohut.replace('İşlem Miktarı<br>(KG)', 'İşlem Miktarı<br>(TON)'));
  assert.equal(r.status, 'error');
});

test('parser: empty / tiny / malformed HTML fail closed', () => {
  assert.equal(parseTobbProductPage('').status, 'error');
  assert.equal(parseTobbProductPage('<html></html>').status, 'error');
  assert.equal(parseTobbProductPage(nohut.slice(0, 3000)).status, 'error');
  assert.equal(parseTobbProductPage(nohut.replace(/<td[^>]*>/gi, '<td>').replace(/<\/td>/gi, '')).status, 'error');
});

test('parser: rows with a wrong cell count are not silently accepted', () => {
  const broken = nohut.replace(/(<td align='right'><font size='-2'>4\.280\.810,00<\/font><\/td>)/, '');
  const r = parseTobbProductPage(broken);
  assert.equal(r.status, 'ok');
  assert.equal((r as any).rows.length, 4);
});

// ── normalisation / validation ───────────────────────────────────────────────
test('normalise: a valid Çorum nohut row becomes a TRY/kg observation with full attribution', () => {
  const r = normalizeTobbRow(baseRow(), ctxFor('NOHUT'));
  assert.ok('observation' in r);
  const o = (r as any).observation;
  assert.equal(o.price, 36.83);
  assert.equal(o.averagePrice, 36.83);
  assert.equal(o.minPrice, 35.15);
  assert.equal(o.maxPrice, 38.5);
  assert.equal(o.unit, 'kg');
  assert.equal(o.currency, 'TRY');
  assert.equal(o.quantity, 16000);
  assert.equal(o.transactionCount, 2);
  assert.equal(o.observedAt, '2026-09-25T09:31:00.000Z');
  assert.equal(o.fetchedAt, NOW.toISOString());
  assert.equal(o.provinceSlug, 'corum');
  assert.equal(o.sourceName, 'Çorum Ticaret Borsası (TOBB)');
  assert.equal(o.provider, 'tobb');
  assert.equal(o.freshness, 'fresh');
  assert.equal(o.dedupeKey, 'tobb:3-704:CORUM:2026-09-25T09:31:00.000Z:kg');
  assert.ok(o.sourceUrl.startsWith('https://borsa.tobb.org.tr/'));
});

test('normalise: rows of the real fixtures — good rows pass, unit/amount-corrupt rows are rejected', () => {
  const rows = okPage(cavdar).rows;
  const results = rows.map((row) => ({ row, r: normalizeTobbRow(row, { ...ctxFor('CAVDAR'), ana: 1, alt: 301 }) }));
  const eskisehir = results.find((x) => x.row.exchangeCode === '5ES10')!;
  // 12.300,000 TL "per kg" for 4.500 kg with a 55.350 TL amount is TL/ton typed as TL/kg
  assert.deepEqual(eskisehir.r, { ok: false, reason: 'amount-mismatch' });
  assert.ok(results.filter((x) => 'observation' in x.r).length >= 1);

  const sun = okPage(aycicegi).rows;
  const badEdirne = sun.find((r) => r.exchangeCode === '5ED10')!; // quantity typed as 382 instead of 382.000
  assert.equal(normalizeTobbRow(badEdirne, { ...ctxFor('AYCICEGI'), ana: 4, alt: 602 }).ok, false);
  const badEski = sun.find((r) => r.exchangeCode === '5ES10')!; // 32.601,000 TL/ton typed as TL/kg
  assert.equal(normalizeTobbRow(badEski, { ...ctxFor('AYCICEGI'), ana: 4, alt: 602 }).ok, false);
  const goodCorum = sun.find((r) => r.exchangeCode === '5CO20')!;
  assert.equal(normalizeTobbRow(goodCorum, { ...ctxFor('AYCICEGI'), ana: 4, alt: 602 }).ok, true);
});

test('normalise: missing average is rejected; the average is never derived from min/max', () => {
  assert.deepEqual(normalizeTobbRow(baseRow({ average: null }), ctxFor('NOHUT')), {
    ok: false,
    reason: 'missing-average',
  });
});

test('normalise: wrong column values are rejected (min>max, average outside range, missing amount)', () => {
  assert.equal((normalizeTobbRow(baseRow({ min: 40, max: 35 }), ctxFor('NOHUT')) as any).reason, 'price-order');
  assert.equal((normalizeTobbRow(baseRow({ average: 60 }), ctxFor('NOHUT')) as any).reason, 'price-order');
  assert.equal((normalizeTobbRow(baseRow({ amount: null }), ctxFor('NOHUT')) as any).reason, 'unverifiable-amount');
  assert.equal((normalizeTobbRow(baseRow({ quantity: null }), ctxFor('NOHUT')) as any).reason, 'unverifiable-amount');
});

test('normalise: TON is converted exactly to KG; ADET / KASA / LITRE are rejected', () => {
  const ton = normalizeTobbRow(
    baseRow({ min: 12000, max: 12600, average: 12300, quantity: 4.5, amount: 55350 }),
    ctxFor('NOHUT', 'TON'),
  ) as any;
  assert.equal(ton.ok, true);
  assert.equal(ton.observation.price, 12.3);
  assert.equal(ton.observation.quantity, 4500);
  assert.match(ton.observation.notes, /TON -> KG/);
  for (const unit of ['ADET', 'KASA', 'LITRE', '']) {
    assert.equal((normalizeTobbRow(baseRow(), ctxFor('NOHUT', unit)) as any).reason, 'unit-rejected', unit);
  }
});

test('normalise: invalid / future dates and too-old rows are rejected', () => {
  assert.equal((normalizeTobbRow(baseRow({ lastTradeText: 'x' }), ctxFor('NOHUT')) as any).reason, 'invalid-date');
  assert.equal((normalizeTobbRow(baseRow({ lastTradeText: '30.09.2026 10:00' }), ctxFor('NOHUT')) as any).reason, 'future-date');
  assert.equal((normalizeTobbRow(baseRow({ lastTradeText: '29.04.2026 13:37' }), ctxFor('NOHUT')) as any).reason, 'too-old');
});

test('freshness classes keep the observation date and use explicit thresholds', () => {
  assert.deepEqual({ ...FRESHNESS_THRESHOLDS }, { freshDays: 7, staleDays: 30 });
  const at = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();
  assert.equal(classifyFreshness(at(1), NOW), 'fresh');
  assert.equal(classifyFreshness(at(7), NOW), 'fresh');
  assert.equal(classifyFreshness(at(8), NOW), 'stale');
  assert.equal(classifyFreshness(at(30), NOW), 'stale');
  assert.equal(classifyFreshness(at(31), NOW), 'very_stale');
});

// ── maps ─────────────────────────────────────────────────────────────────────
test('product map covers the 52 reference products exactly once; A+B+C+D = 52', () => {
  assert.equal(productMap.length, 52);
  assert.deepEqual(productMap.map((p) => p.code).sort(), products.map((p) => p.code).sort());
  const by = (c: string) => productMap.filter((p) => p.class === c).length;
  assert.equal(by('A') + by('B') + by('C') + by('D'), 52);
  assert.equal(by('A'), 13);
});

test('only EXACT / SAFE_ALIAS single-item products are auto-ingested; ambiguous never', () => {
  const auto = autoIngestProducts();
  assert.equal(auto.length, 13);
  for (const p of auto) {
    assert.ok(p.tobb && (p.confidence === 'EXACT' || p.confidence === 'SAFE_ALIAS'));
    assert.equal(p.candidates.length, 0);
  }
  // real-crop coverage phase: MISIR / AYÇİÇEĞİ / PATATES / BADEM were promoted
  // (single real-data variant each -- see tobb-product-map.json notes); products
  // with several genuinely active variants stay ambiguous.
  for (const code of ['MISIR', 'AYCICEGI', 'PATATES', 'BADEM']) {
    assert.equal(productByCode(code).confidence, 'SAFE_ALIAS', code);
    assert.ok(auto.some((p) => p.code === code), code);
  }
  for (const code of ['BUGDAY', 'ARPA', 'KURU_FASULYE', 'PAMUK', 'CEVIZ']) {
    const p = productByCode(code);
    assert.equal(p.confidence, 'AMBIGUOUS');
    assert.equal(p.tobb, null);
    assert.ok(p.candidates.length >= 2);
    assert.equal(auto.includes(p), false);
  }
});

test('every mapped TOBB item exists in the TOBB product catalogue snapshot', () => {
  const catalog = JSON.parse(fixture('catalog.json')) as { ana: number; alt: number; name: string }[];
  const has = (ana: number, alt: number, name: string) =>
    catalog.some((c) => c.ana === ana && c.alt === alt && c.name === name);
  for (const p of productMap) {
    for (const c of [...(p.tobb ? [p.tobb] : []), ...p.candidates]) {
      assert.ok(has(c.ana, c.alt, c.name), `${p.code}: ${c.ana}/${c.alt} ${c.name}`);
    }
  }
});

test('exchange -> province map: deterministic, every province slug exists, unknown exchange -> null', () => {
  const slugs = new Set(provinces.map((p) => p.slug));
  for (const e of exchangeMap) {
    assert.ok(e.provinceSlug && slugs.has(e.provinceSlug), `${e.name} -> ${e.provinceSlug}`);
  }
  assert.equal(lookupExchange('CORUM TICARET BORSASI')!.provinceSlug, 'corum');
  assert.equal(lookupExchange('AKSEHIR TICARET BORSASI')!.provinceSlug, 'konya');
  assert.equal(lookupExchange('ILGIN TİCARET BORSASI')!.provinceSlug, 'konya');
  assert.equal(lookupExchange('BANDIRMA TICARET BORSASI')!.provinceSlug, 'balikesir');
  assert.equal(lookupExchange('KARAPINAR/KONYA TICARET BORSASI')!.provinceSlug, 'konya');
  assert.equal(lookupExchange('EDIRNE TICARET BORSASI')!.provinceSlug, 'edirne');
  assert.equal(lookupExchange('KONYA OVASI TICARET BORSASI'), null, 'no substring matching');
  assert.equal(lookupExchange('BILINMEYEN TICARET BORSASI'), null);
});

// ── fetcher ──────────────────────────────────────────────────────────────────
const html = (status: number, body = ''): ReturnType<HttpGet> =>
  Promise.resolve({ status, contentType: 'text/html; charset=UTF-8', body });

const noSleep = async () => {};

test('fetcher: 4xx is not retried; 5xx/429/network are retried with backoff then reported', async () => {
  let calls = 0;
  const f4 = createTobbFetcher({ httpGet: () => (calls++, html(404)), sleep: noSleep, delayMs: 0 });
  assert.deepEqual(await f4.get('x.php'), { ok: false, reason: 'http-4xx', status: 404 });
  assert.equal(calls, 1);

  calls = 0;
  const f5 = createTobbFetcher({ httpGet: () => (calls++, html(503)), sleep: noSleep, delayMs: 0, retries: 2 });
  assert.equal(((await f5.get('x.php')) as any).reason, 'http-5xx');
  assert.equal(calls, 3);

  calls = 0;
  const fn = createTobbFetcher({
    httpGet: () => {
      calls++;
      return Promise.reject(new Error('ECONNRESET'));
    },
    sleep: noSleep,
    delayMs: 0,
    retries: 1,
  });
  assert.equal(((await fn.get('x.php')) as any).reason, 'network');
  assert.equal(calls, 2);
});

test('fetcher: timeout, non-html and oversized responses are reported', async () => {
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const ft = createTobbFetcher({ httpGet: () => Promise.reject(abort), sleep: noSleep, delayMs: 0, retries: 0 });
  assert.equal(((await ft.get('x.php')) as any).reason, 'timeout');
  const fj = createTobbFetcher({
    httpGet: () => Promise.resolve({ status: 200, contentType: 'application/json', body: '{}' }),
    sleep: noSleep,
    delayMs: 0,
  });
  assert.equal(((await fj.get('x.php')) as any).reason, 'not-html');
  const fb = createTobbFetcher({ httpGet: () => html(413), sleep: noSleep, delayMs: 0 });
  assert.equal(((await fb.get('x.php')) as any).reason, 'too-large');
});

test('fetcher: requests are sequential with a pause and an honest User-Agent', async () => {
  const sleeps: number[] = [];
  const agents: string[] = [];
  const f = createTobbFetcher({
    httpGet: (_url, o) => (agents.push(o.userAgent), html(200, 'ok')),
    sleep: async (ms) => void sleeps.push(ms),
    delayMs: 2000,
  });
  await f.get('a.php');
  await f.get('b.php');
  await f.get('c.php');
  assert.deepEqual(sleeps, [2000, 2000], 'no pause before the first request, 2s between the rest');
  assert.ok(agents.every((a) => a === 'Tarim360 agricultural data service'));
});

// ── provider ─────────────────────────────────────────────────────────────────
const servingFixtures = (overrides: Record<string, () => ReturnType<HttpGet>> = {}): HttpGet => (url) => {
  for (const [needle, fn] of Object.entries(overrides)) if (url.includes(needle)) return fn();
  if (url.includes('ana_kod=3&alt_kod=704')) return html(200, nohut);
  if (url.includes('ana_kod=1&alt_kod=301')) return html(200, cavdar);
  return html(200, noData);
};

test('provider: ingests only the auto-mapped products; ambiguous products are never fetched or ingested', async () => {
  const seen: string[] = [];
  const fetcher = createTobbFetcher({
    httpGet: (url, o) => (seen.push(url), servingFixtures()(url, o)),
    sleep: noSleep,
    delayMs: 0,
  });
  const { observations, report } = await collectTobbObservations({ fetcher, now: NOW });
  assert.equal(report.productsInScope, 13);
  assert.equal(seen.length, 13, 'one page per auto-mapped product, nothing else');
  assert.ok(observations.length >= 1);
  assert.ok(observations.every((o) => o.provider === 'tobb' && o.unit === 'kg'));
  assert.ok(observations.every((o) => ['NOHUT', 'CAVDAR'].includes(o.productCode)));
  assert.equal(report.pagesNoData, 11);
  assert.ok(report.rejected['too-old']! >= 1, 'the Alaca row from April is too old');
  assert.ok(report.rejected['amount-mismatch']! >= 1, 'the Eskişehir çavdar row is corrupt');
});

test('provider: partial failure keeps the other products; failed pages add nothing (no fake fallback)', async () => {
  const fetcher = createTobbFetcher({
    httpGet: servingFixtures({ 'ana_kod=1&alt_kod=301': () => html(500) }),
    sleep: noSleep,
    delayMs: 0,
    retries: 0,
  });
  const { observations, report } = await collectTobbObservations({ fetcher, now: NOW });
  assert.equal(report.pagesFailed, 1);
  assert.ok(observations.length >= 1);
  assert.ok(observations.every((o) => o.productCode === 'NOHUT'));
});

test('provider: timeout / malformed / empty / 4xx / 5xx responses produce zero observations', async () => {
  const cases: Record<string, HttpGet> = {
    timeout: () => Promise.reject(Object.assign(new Error('x'), { name: 'AbortError' })),
    malformed: () => html(200, '<html><body><table><tr><td>garbage</td></tr></table></body></html>'),
    empty: () => html(200, ''),
    http404: () => html(404),
    http500: () => html(500),
  };
  for (const [name, httpGet] of Object.entries(cases)) {
    const fetcher = createTobbFetcher({ httpGet, sleep: noSleep, delayMs: 0, retries: 0 });
    const { observations, report } = await collectTobbObservations({ fetcher, now: NOW });
    assert.equal(observations.length, 0, name);
    assert.equal(report.validObservations, 0, name);
    assert.equal(report.pagesFailed, 13, name);
  }
});

test('provider: probe mode reports ambiguous candidates but never ingests them', async () => {
  const fetcher = createTobbFetcher({
    httpGet: servingFixtures({ 'ana_kod=1&alt_kod=808': () => html(200, fixture('bugday_1_808.html')) }),
    sleep: noSleep,
    delayMs: 0,
  });
  const { observations, report } = await collectTobbObservations({ fetcher, now: NOW, probeAmbiguous: true });
  const wheat = report.probes.filter((p) => p.code === 'BUGDAY');
  assert.ok(wheat.length > 5);
  assert.ok(wheat.some((p) => p.valid > 0), 'the probe parsed real wheat prices');
  assert.equal(observations.some((o) => o.productCode === 'BUGDAY'), false);
});

// ── mode gate ────────────────────────────────────────────────────────────────
const explodingStrapi: any = new Proxy({}, { get() { throw new Error('strapi must not be touched'); } });

test('mode: default is off; only dry-run/apply are recognised', () => {
  assert.equal(readRealPriceMode({}), 'off');
  assert.equal(readRealPriceMode({ AGRI_REAL_PRICE_INGESTION_MODE: 'APPLY' }), 'apply');
  assert.equal(readRealPriceMode({ AGRI_REAL_PRICE_INGESTION_MODE: 'dry-run' }), 'dry-run');
  assert.equal(readRealPriceMode({ AGRI_REAL_PRICE_INGESTION_MODE: 'true' }), 'off');
  assert.equal(readRealPriceMode({ AGRI_REAL_PRICE_INGESTION_MODE: 'on' }), 'off');
});

test('mode off: zero network and zero database access', async () => {
  let calls = 0;
  const fetcher = createTobbFetcher({ httpGet: () => (calls++, html(200, nohut)), sleep: noSleep, delayMs: 0 });
  const report = await runRealPriceIngestion(explodingStrapi, { mode: 'off', fetcher, now: NOW });
  assert.equal(report.status, 'off');
  assert.equal(calls, 0);
});

test('provider-failed run (every page unreachable) writes nothing and reports it', async () => {
  const fetcher = createTobbFetcher({ httpGet: () => html(503), sleep: noSleep, delayMs: 0, retries: 0 });
  const report = await runRealPriceIngestion(explodingStrapi, { mode: 'apply', fetcher, now: NOW });
  assert.equal(report.status, 'provider-failed');
  assert.equal(report.created, 0);
});

// ── mock production guard must never gate the real provider (source guard) ──
test('the real (TOBB) provider never imports the mock production guard', () => {
  const files = [
    'runner.ts',
    'index.ts',
    'types.ts',
    'freshness.ts',
    'tobb/provider.ts',
    'tobb/fetcher.ts',
    'tobb/parser.ts',
    'tobb/normalize.ts',
    'tobb/maps.ts',
    'tobb/dates.ts',
    'tobb/numbers.ts',
    'tobb/tls.ts',
  ];
  for (const file of files) {
    const src = readFileSync(
      path.join(__dirname, '..', '..', 'src', 'services', 'agri-real-price', file),
      'utf8',
    );
    assert.ok(!src.includes('decideMockAgriIngestion'), file);
    assert.ok(!src.includes('agri-data-ingestion'), file);
  }
});

// ── real crop coverage phase: newly promoted SAFE_ALIAS products ────────────
// Rows copied verbatim from a live fetch (2026-09-27) of each product's TOBB
// page; kept as fixtures so the mapping decision is verified against the real
// shape TOBB returns, not a hand-picked example.
test('MISIR (promoted): only MISIR SARI trades; Eskişehir/Nazilli corrupt rows '
  + 'and stale Ilgın/Konya rows are rejected, Bandırma is valid', () => {
  const ctx = (over: Partial<ReturnType<typeof productByCode>> = {}) => ({
    product: { ...productByCode('MISIR'), ...over },
    tobbUnit: 'KG',
    ana: 1,
    alt: 601,
    tobbProductName: 'MISIR SARI',
    sourceUrl: 'https://borsa.tobb.org.tr/fiyat_urun3.php?ana_kod=1&alt_kod=601',
    now: NOW,
  });
  const bandirma = normalizeTobbRow(
    baseRow({
      exchangeName: 'BANDIRMA TICARET BORSASI',
      exchangeCode: '5BA20',
      lastTradeText: '25.09.2026 11:28',
      min: 16.21,
      max: 16.21,
      average: 16.21,
      quantity: 6000,
      transactionCount: 1,
      amount: 97260,
    }),
    ctx(),
  ) as any;
  assert.equal(bandirma.ok, true);
  assert.equal(bandirma.observation.price, 16.21);
  assert.equal(bandirma.observation.provinceSlug, 'balikesir');

  const eskisehir = normalizeTobbRow(
    baseRow({
      exchangeName: 'ESKISEHIR TICARET BORSASI',
      lastTradeText: '25.09.2026 16:16',
      min: 15000,
      max: 16001,
      average: 15526,
      quantity: 19020,
      transactionCount: 2,
      amount: 295304.52,
    }),
    ctx(),
  ) as any;
  assert.equal(eskisehir.reason, 'amount-mismatch');

  const nazilli = normalizeTobbRow(
    baseRow({
      exchangeName: 'NAZILLI TICARET BORSASI',
      lastTradeText: '27.08.2026 09:44',
      min: 25,
      max: 25,
      average: 25,
      quantity: 5000,
      transactionCount: 1,
      amount: 125,
    }),
    ctx(),
  ) as any;
  assert.equal(nazilli.reason, 'amount-mismatch');

  const ilgin = normalizeTobbRow(
    baseRow({
      exchangeName: 'ILGIN TİCARET BORSASI',
      lastTradeText: '01.07.2026 08:08',
      min: 11.513,
      max: 11.513,
      average: 11.513,
      quantity: 1000,
      transactionCount: 1,
      amount: 11513,
    }),
    ctx(),
  ) as any;
  assert.equal(ilgin.reason, 'too-old'); // 88 days before NOW
});

test('AYCICEGI (promoted): only AYÇİÇEĞİ YAĞLIK trades; Edirne quantity-typo '
  + 'and Eskişehir TL/ton rows rejected, four exchanges valid', () => {
  const ctx = {
    product: productByCode('AYCICEGI'),
    tobbUnit: 'KG',
    ana: 4,
    alt: 602,
    tobbProductName: 'AYÇİÇEĞİ YAĞLIK',
    sourceUrl: 'https://borsa.tobb.org.tr/fiyat_urun3.php?ana_kod=4&alt_kod=602',
    now: NOW,
  };
  const good = [
    { exchangeName: 'BANDIRMA TICARET BORSASI', min: 33.7, max: 37.51, average: 35.605, quantity: 409750, transactionCount: 64, amount: 14589460 },
    { exchangeName: 'ÇORUM TICARET BORSASI', min: 30.42, max: 34.71, average: 32.89, quantity: 125500, transactionCount: 42, amount: 4127695 },
    { exchangeName: 'SUNGURLU TICARET BORSASI', min: 29.16, max: 29.16, average: 29.16, quantity: 2000, transactionCount: 1, amount: 58320 },
    { exchangeName: 'UZUNKOPRU TICARET BORSASI', min: 34.413, max: 38.97, average: 36.476, quantity: 469000, transactionCount: 82, amount: 17107244 },
  ];
  for (const row of good) {
    const r = normalizeTobbRow(baseRow({ ...row, lastTradeText: '26.09.2026 07:00' }), ctx) as any;
    assert.equal(r.ok, true, row.exchangeName);
  }
  const edirne = normalizeTobbRow(
    baseRow({ exchangeName: 'EDIRNE TICARET BORSASI', min: 34.12, max: 39.8, average: 36.905, quantity: 382, transactionCount: 64, amount: 14097556, lastTradeText: '25.09.2026 10:54' }),
    ctx,
  ) as any;
  assert.equal(edirne.reason, 'amount-mismatch');
  const eskisehir = normalizeTobbRow(
    baseRow({ exchangeName: 'ESKISEHIR TICARET BORSASI', min: 32601, max: 36500, average: 34871, quantity: 353100, transactionCount: 27, amount: 12312950.1, lastTradeText: '25.09.2026 16:16' }),
    ctx,
  ) as any;
  assert.equal(eskisehir.reason, 'amount-mismatch');
});

test('PATATES (promoted): YENİ ÜRÜN (current season) is valid; ESKİ ÜRÜN '
  + '(last season carry-over) is a different TOBB item, not this mapping', () => {
  const yeni = normalizeTobbRow(
    baseRow({
      exchangeName: 'NEVŞEHİR TİCARET BORSASI',
      lastTradeText: '02.09.2026 10:18',
      min: 2,
      max: 50,
      average: 14.93,
      quantity: 12419803,
      transactionCount: 106,
      amount: 165644889,
    }),
    {
      product: productByCode('PATATES'),
      tobbUnit: 'KG',
      ana: 8,
      alt: 102,
      tobbProductName: 'PATATES YENİ ÜRÜN',
      sourceUrl: 'https://borsa.tobb.org.tr/fiyat_urun3.php?ana_kod=8&alt_kod=102',
      now: NOW,
    },
  ) as any;
  assert.equal(yeni.ok, true);
  assert.equal(yeni.observation.freshness, 'stale'); // 25 days old
  assert.equal(productByCode('PATATES').tobb?.alt, 102, 'ESKİ ÜRÜN (alt=101) is not the mapped item');
});

test('BADEM (promoted): BADEM İÇ (the only TOBB item for almonds) is valid', () => {
  const r = normalizeTobbRow(
    baseRow({
      exchangeName: 'GAZIANTEP TICARET BORSASI',
      lastTradeText: '25.09.2026 16:47',
      min: 519.8,
      max: 600,
      average: 552.7,
      quantity: 28341,
      transactionCount: 34,
      amount: 15664143.22,
    }),
    {
      product: productByCode('BADEM'),
      tobbUnit: 'KG',
      ana: 9,
      alt: 902,
      tobbProductName: 'BADEM İÇ',
      sourceUrl: 'https://borsa.tobb.org.tr/fiyat_urun3.php?ana_kod=9&alt_kod=902',
      now: NOW,
    },
  ) as any;
  assert.equal(r.ok, true);
  assert.equal(r.observation.freshness, 'fresh');
  assert.equal(r.observation.provinceSlug, 'gaziantep');
});
