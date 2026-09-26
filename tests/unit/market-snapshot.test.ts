import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMarketSnapshot,
  parseBigparaBrentUsd,
  parseBigparaFuel,
  parseBigparaSilverGramTry,
  parseOpenErRates,
  parseTcmbRate,
  stripHtml,
  type MarketIo,
} from '../../src/utils/market-snapshot';

// Fragments copied from the real provider pages (2026-09-26).
const GOLD_PAGE =
  'ALTIN (TL/GR) Piyasalar GLDGR Gram Altın (TL/Gr) 6.741,28 %+0,85 1,20 ' +
  'Gümüş Fiyatları Sembol (3) Grafik Fiyat Fark (%) Fark Alış Satış G.Yüksek G.Düşük ' +
  'SXAGGR Gümüş (TL/GR) 101,199 %&#x2B;0,85 0,86 101,136 101,199 102,514 99,7853 XAGEUR Gümüş (Euro/ONS) 56,4600';
const BRENT_PAGE =
  'Brent Petrol Fiyatı Canlı - Güncel ve Anlık Ham Petrol Varil Fiyatları Ne Kadar & Kaç Dolar (Grafik) ' +
  'Piyasalar BRENT BRENT CORN MISIR %1,22 ' +
  '104,450 %-2,02 -2,15 Alış / Satış 104,450 / 104,450 25 Eylül, 23:58:59 Brent Petrol';
const FUEL_PAGE =
  'Kurşunsuz Benzin 95 Oktan 80,40 Litre Yüksek Kükürtlü Fuel Oil 47,60 Kilogram Motorin 93,44 Litre Gazyağı 94,73 Litre';

const OPEN_ER = { result: 'success', rates: { TRY: 48.919186, EUR: 0.877267 } };
const TCMB_XML =
  '<Tarih_Date><Currency CurrencyCode="USD"><ForexSelling>48.9500</ForexSelling></Currency>' +
  '<Currency CurrencyCode="EUR"><ForexSelling>55.8000</ForexSelling></Currency></Tarih_Date>';

type Routes = Record<string, unknown | null | Error>;
const io = (json: Routes, text: Routes, env: Record<string, string> = {}): MarketIo => ({
  env,
  now: () => new Date('2026-09-26T18:00:00Z'),
  fetchJson: async (url) => {
    for (const [prefix, value] of Object.entries(json)) {
      if (url.startsWith(prefix)) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    return null;
  },
  fetchText: async (url) => {
    for (const [prefix, value] of Object.entries(text)) {
      if (url.startsWith(prefix)) {
        if (value instanceof Error) throw value;
        return value as string | null;
      }
    }
    return null;
  },
});

test('EUR/TRY is derived from the same open.er-api response as USD', () => {
  const r = parseOpenErRates(OPEN_ER);
  assert.equal(r.usdTry, 48.919186);
  assert.ok(Math.abs((r.eurTry as number) - 55.7632) < 0.001);
});

test('EUR falls back to TCMB when open.er-api has no EUR', async () => {
  const s = await buildMarketSnapshot(
    io(
      { 'https://open.er-api.com': { rates: { TRY: 48.9 } } },
      { 'https://www.tcmb.gov.tr': TCMB_XML },
    ),
  );
  assert.equal(s.usdTry, 48.9);
  assert.equal(s.eurTry, 55.8);
  assert.equal(s.sources.eur, 'tcmb');
});

test('silver: bigpara "Gümüş (TL/GR)" parses with 3 decimals (was ASCII-only label + 2-decimal cut)', () => {
  assert.equal(parseBigparaSilverGramTry(stripHtml(GOLD_PAGE)), 101.199);
});

test('silver comes from a real source when gold-api is down', async () => {
  const s = await buildMarketSnapshot(
    io({ 'https://open.er-api.com': OPEN_ER }, { 'https://bigpara.hurriyet.com.tr/altin': GOLD_PAGE }),
  );
  assert.equal(s.silverGramTry, 101.199);
  assert.equal(s.sources.silver, 'bigpara');
});

test('silver is null (not invented) when every source fails', async () => {
  const s = await buildMarketSnapshot(io({ 'https://open.er-api.com': OPEN_ER }, {}));
  assert.equal(s.silverGramTry, null);
  assert.equal(s.goldGramTry, null);
  assert.equal(s.sources.silver, undefined);
});

test('Brent: the instrument "Alış / Satış" pair is parsed as USD/barrel', () => {
  assert.equal(parseBigparaBrentUsd(stripHtml(BRENT_PAGE)), 104.45);
});

test('Brent: the old page-title/percent match (1.22) is not accepted', async () => {
  // A page whose only number after "Brent Petrol" is a percent-change column.
  const bad = 'Brent Petrol Piyasalar %1,22 ';
  assert.equal(parseBigparaBrentUsd(stripHtml(bad)), null);
  const s = await buildMarketSnapshot(
    io({ 'https://open.er-api.com': OPEN_ER }, { 'https://bigpara.hurriyet.com.tr/kobi': bad }),
  );
  assert.equal(s.brentUsd, null);
});

test('Brent: an out-of-unit value from a provider is rejected, never cached as a price', async () => {
  const s = await buildMarketSnapshot(
    io(
      { 'https://open.er-api.com': OPEN_ER },
      { 'https://bigpara.hurriyet.com.tr/kobi': 'Alış / Satış 1,22 / 1,22' },
    ),
  );
  assert.equal(s.brentUsd, null);
  const ok = await buildMarketSnapshot(
    io({ 'https://open.er-api.com': OPEN_ER }, { 'https://bigpara.hurriyet.com.tr/kobi': BRENT_PAGE }),
  );
  assert.equal(ok.brentUsd, 104.45);
  assert.equal(ok.sources.brent, 'bigpara');
});

test('fuel prices are read next to their "Litre" unit', () => {
  const f = parseBigparaFuel(FUEL_PAGE);
  assert.equal(f.gasoline, 80.4);
  assert.equal(f.diesel, 93.44);
});

test('provider failures give a partial snapshot; other fields are unaffected', async () => {
  const s = await buildMarketSnapshot(
    io(
      {
        'https://open.er-api.com': OPEN_ER,
        'https://api.gold-api.com': new Error('down'),
        'https://api.binance.com': { price: '84160.00' },
      },
      {
        'https://bigpara.hurriyet.com.tr/akaryakit': FUEL_PAGE,
        'https://bigpara.hurriyet.com.tr/altin': new Error('html changed'),
      },
    ),
  );
  assert.equal(s.usdTry, 48.919186);
  assert.equal(s.dieselTry, 93.44);
  assert.equal(s.btcUsd, 84160);
  assert.equal(s.goldGramTry, null);
  assert.equal(s.silverGramTry, null);
  assert.equal(s.brentUsd, null);
});

test('with every provider down nothing is invented', async () => {
  const s = await buildMarketSnapshot(io({}, {}));
  for (const key of [
    'usdTry',
    'eurTry',
    'goldGramTry',
    'silverGramTry',
    'fuelTry',
    'gasolineTry',
    'dieselTry',
    'brentUsd',
    'btcUsd',
    'ethUsd',
  ] as const) {
    assert.equal(s[key], null, key);
  }
  assert.deepEqual(s.sources, {});
});

test('a non-finite / non-positive provider value is rejected', async () => {
  const s = await buildMarketSnapshot(
    io({ 'https://open.er-api.com': { rates: { TRY: 0, EUR: 0.9 } }, 'https://api.binance.com': { price: '-5' } }, {}),
  );
  assert.equal(s.usdTry, null);
  assert.equal(s.eurTry, null);
  assert.equal(s.btcUsd, null);
});

test('TCMB parser reads USD and EUR blocks', () => {
  assert.equal(parseTcmbRate(TCMB_XML, 'USD'), 48.95);
  assert.equal(parseTcmbRate(TCMB_XML, 'EUR'), 55.8);
  assert.equal(parseTcmbRate(null, 'EUR'), null);
});
