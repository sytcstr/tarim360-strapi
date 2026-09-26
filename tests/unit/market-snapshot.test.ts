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

// ── gold fallback hardening (production 10967.28 incident) ──────────────────
// Trimmed copy of the real truncgil v4 payload: gram gold is key GRA, and the
// list also carries CEYREKALTIN (quarter coin, 10967.28 TRY per COIN).
const TRUNCGIL = {
  Update_Date: '2026-09-26 21:50:00',
  USD: { Buying: 48.9, Selling: 48.95, Name: 'USD', Type: 'Currency' },
  GRA: { Buying: 6739.97, Selling: 6740.8, Name: 'GRAMALTIN', Type: 'Gold', Change: 0.33 },
  GUMUS: { Buying: 101.14, Selling: 101.18, Name: 'GUMUS', Type: 'Gold', Change: 0.84 },
  ONS: { Buying: 0, Selling: 0, Name: 'ONS', Type: 'Gold' },
  CEYREKALTIN: { Buying: 10722.45, Selling: 10967.28, Name: 'CEYREKALTIN', Type: 'Gold' },
  YARIMALTIN: { Buying: 21377.89, Selling: 21934.56, Name: 'YARIMALTIN', Type: 'Gold' },
  TAMALTIN: { Buying: 42889.81, Selling: 43734.95, Name: 'TAMALTIN', Type: 'Gold' },
  '18AYARALTIN': { Buying: 4892.12, Selling: 4896.7, Name: '18AYARALTIN', Type: 'Gold' },
};
const { GRA: _gra, ...TRUNCGIL_WITHOUT_GRAM } = TRUNCGIL;

test('truncgil: gram gold is selected by its exact name, silver by GUMUS', async () => {
  const { parseTruncgilGramGoldTry, parseTruncgilSilverGramTry } = await import('../../src/utils/market-snapshot');
  assert.equal(parseTruncgilGramGoldTry(TRUNCGIL), 6740.8);
  assert.equal(parseTruncgilSilverGramTry(TRUNCGIL), 101.18);
});

test('truncgil: quarter/half/full/coin/ayar products are never taken as gram gold', async () => {
  const { parseTruncgilGramGoldTry } = await import('../../src/utils/market-snapshot');
  assert.equal(parseTruncgilGramGoldTry(TRUNCGIL_WITHOUT_GRAM as any), null);
  assert.equal(parseTruncgilGramGoldTry(null), null);
});

test('bigpara + gold-api down, truncgil up: gold is the gram price, NOT the 10967.28 coin price', async () => {
  const s = await buildMarketSnapshot(
    io(
      {
        'https://open.er-api.com': OPEN_ER,
        'https://api.gold-api.com': null,
        'https://finans.truncgil.com': TRUNCGIL,
      },
      {},
    ),
  );
  assert.equal(s.goldGramTry, 6740.8);
  assert.notEqual(s.goldGramTry, 10967.28);
  assert.equal(s.sources.gold, 'truncgil');
  assert.equal(s.silverGramTry, 101.18);
});

test('bigpara unavailable and no reliable fallback for gram gold: gold is null', async () => {
  const s = await buildMarketSnapshot(
    io(
      {
        'https://open.er-api.com': OPEN_ER,
        'https://api.gold-api.com': null,
        'https://finans.truncgil.com': TRUNCGIL_WITHOUT_GRAM,
      },
      {},
    ),
  );
  assert.equal(s.goldGramTry, null);
  assert.equal(s.sources.gold, undefined);
  // the other fields keep working (partial snapshot)
  assert.equal(s.usdTry, 48.919186);
  assert.ok(s.eurTry != null);
  assert.equal(s.silverGramTry, 101.18);
});

test('correct gold responses still give the correct gram TRY (gold-api and bigpara)', async () => {
  const viaGoldApi = await buildMarketSnapshot(
    io(
      { 'https://open.er-api.com': OPEN_ER, 'https://api.gold-api.com/price/XAU': { price: 4286.2 } },
      {},
    ),
  );
  assert.ok(Math.abs((viaGoldApi.goldGramTry as number) - 6741.3) < 1);
  assert.equal(viaGoldApi.sources.gold, 'gold-api');
  const viaBigpara = await buildMarketSnapshot(
    io(
      { 'https://open.er-api.com': OPEN_ER },
      { 'https://bigpara.hurriyet.com.tr/altin': 'ALTIN (TL/GR) Alarm 6.740,80 %+0,33' },
    ),
  );
  assert.equal(viaBigpara.goldGramTry, 6740.8);
  assert.equal(viaBigpara.sources.gold, 'bigpara');
});

test('a provider failure for gold does not disturb Brent / fuel / crypto', async () => {
  const s = await buildMarketSnapshot(
    io(
      {
        'https://open.er-api.com': OPEN_ER,
        'https://api.gold-api.com': new Error('down'),
        'https://finans.truncgil.com': new Error('down'),
        'https://api.binance.com': { price: '84160.00' },
      },
      {
        'https://bigpara.hurriyet.com.tr/altin': new Error('down'),
        'https://bigpara.hurriyet.com.tr/kobi': BRENT_PAGE,
        'https://bigpara.hurriyet.com.tr/akaryakit': FUEL_PAGE,
      },
    ),
  );
  assert.equal(s.goldGramTry, null);
  assert.equal(s.brentUsd, 104.45);
  assert.equal(s.dieselTry, 93.44);
  assert.equal(s.btcUsd, 84160);
});
