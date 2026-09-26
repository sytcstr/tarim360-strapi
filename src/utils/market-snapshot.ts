/**
 * Market snapshot pipeline (USD/EUR/gold/silver/Brent/fuel/BTC/ETH).
 *
 * Rules:
 *  - Every value comes from a real provider response. Nothing is invented,
 *    interpolated or defaulted: if every source for a field fails, the field is
 *    `null` (the app shows "—").
 *  - Every value must be finite, > 0 and inside a UNIT sanity range. The ranges
 *    only catch parser/unit mistakes (wrong column, percent instead of price,
 *    per-ounce vs per-gram ...), they are not price forecasts and are wide
 *    enough that real market moves never hit them.
 *  - A failing provider never breaks the other fields (partial snapshot).
 *
 * All network access goes through `MarketIo` so the pipeline is testable.
 */

export type MarketIo = {
  fetchJson: (url: string, init?: RequestInit) => Promise<any | null>;
  fetchText: (url: string, init?: RequestInit) => Promise<string | null>;
  env: Record<string, string | undefined>;
  now?: () => Date;
};

export type MarketSnapshot = {
  updatedAt: string;
  usdTry: number | null;
  eurTry: number | null;
  goldGramTry: number | null;
  silverGramTry: number | null;
  fuelTry: number | null;
  gasolineTry: number | null;
  dieselTry: number | null;
  brentUsd: number | null;
  btcUsd: number | null;
  ethUsd: number | null;
  sources: Record<string, string>;
  cached?: boolean;
  cacheAgeSec?: number;
};

// ── sanity ranges (unit checks, see header) ─────────────────────────────────
export const MARKET_RANGES = {
  /** TRY per 1 USD / EUR. */
  fxTry: { min: 1, max: 1000 },
  /** EUR/USD cross implied by the two TRY rates. */
  eurUsdCross: { min: 0.5, max: 2 },
  /** Gold in USD per gram, derived from the TRY gram price and USD/TRY. */
  goldUsdPerGram: { min: 5, max: 1000 },
  /** Silver in USD per gram, derived the same way. */
  silverUsdPerGram: { min: 0.05, max: 100 },
  /** Brent crude, USD per barrel (bigpara "Brent Petrol" is quoted in USD/varil). */
  brentUsd: { min: 10, max: 300 },
  /** Pump prices, TRY per litre. */
  fuelTryPerLitre: { min: 1, max: 1000 },
  btcUsd: { min: 100, max: 5_000_000 },
  ethUsd: { min: 5, max: 500_000 },
} as const;

export const inRange = (
  value: number | null,
  range: { min: number; max: number },
): number | null =>
  value != null &&
  Number.isFinite(value) &&
  value > 0 &&
  value >= range.min &&
  value <= range.max
    ? value
    : null;

// ── parsing helpers ─────────────────────────────────────────────────────────
const cleanText = (v: unknown) => String(v ?? '').trim();

export const parseNum = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const raw = cleanText(v)
    .replace(/[₺$€%]/g, '')
    .replace(/\s+/g, '');
  if (!raw) return null;
  const hasComma = raw.includes(',');
  const hasDot = raw.includes('.');
  let normalized = raw;
  if (hasComma && hasDot) {
    normalized =
      raw.lastIndexOf(',') > raw.lastIndexOf('.')
        ? raw.replace(/\./g, '').replace(',', '.')
        : raw.replace(/,/g, '');
  } else if (hasComma) {
    normalized = raw.replace(',', '.');
  }
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
};

const normalizeKey = (raw: unknown) =>
  cleanText(raw)
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const hasHint = (text: unknown, hints: string[]) => {
  const normalized = normalizeKey(text);
  return hints.some((hint) => normalized.includes(normalizeKey(hint)));
};

const extractPreferredValue = (data: unknown): number | null => {
  if (typeof data === 'number' || typeof data === 'string') return parseNum(data);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const map = data as Record<string, unknown>;
  const preferredKeys = ['selling', 'sell', 'price', 'value', 'last', 'close', 'rate', 'deger', 'amount'];
  for (const preferredKey of preferredKeys) {
    for (const [key, value] of Object.entries(map)) {
      if (!normalizeKey(key).includes(preferredKey)) continue;
      const num = parseNum(value);
      if (num != null) return num;
    }
  }
  for (const value of Object.values(map)) {
    const num = parseNum(value);
    if (num != null) return num;
  }
  return null;
};

const extractNamedValue = (data: unknown, hints: string[]): number | null => {
  if (!data) return null;
  if (Array.isArray(data)) {
    for (const row of data) {
      if (Array.isArray(row) && row.length >= 2 && hasHint(row[0], hints)) {
        const num = parseNum(row[1]);
        if (num != null) return num;
      }
      const nested = extractNamedValue(row, hints);
      if (nested != null) return nested;
    }
    return null;
  }
  if (typeof data !== 'object') return null;
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (hasHint(key, hints)) {
      const direct = extractPreferredValue(value);
      if (direct != null) return direct;
    }
  }
  for (const value of Object.values(data as Record<string, unknown>)) {
    const nested = extractNamedValue(value, hints);
    if (nested != null) return nested;
  }
  return null;
};

export const stripHtml = (raw: string) =>
  raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#252;/g, 'ü')
    .replace(/&#220;/g, 'Ü')
    .replace(/&#246;/g, 'ö')
    .replace(/&#214;/g, 'Ö')
    .replace(/&#231;/g, 'ç')
    .replace(/&#199;/g, 'Ç')
    .replace(/&#351;/g, 'ş')
    .replace(/&#350;/g, 'Ş')
    .replace(/&#287;/g, 'ğ')
    .replace(/&#286;/g, 'Ğ')
    .replace(/\s+/g, ' ')
    .trim();

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Turkish-formatted decimal: 1.234,56 / 101,199 / 6740,8 (2-4 decimals). */
const TR_NUMBER = '[0-9]{1,3}(?:\\.[0-9]{3})+,[0-9]{2,4}|[0-9]+,[0-9]{2,4}';

const firstTrNumber = (segment: string): number | null => {
  const raw = segment.match(new RegExp(`(?<![0-9.,])(?:${TR_NUMBER})(?![0-9])`))?.[0];
  return raw ? parseNum(raw) : null;
};

export const extractFirstNumberAfterLabel = (
  text: string,
  label: string,
  maxWindow = 240,
): number | null => {
  const pattern = new RegExp(`${escapeRegExp(label)}([\\s\\S]{0,${maxWindow}})`, 'gi');
  for (const match of text.matchAll(pattern)) {
    const num = firstTrNumber(match[1] ?? '');
    if (num != null) return num;
  }
  return null;
};

/** `<label> 93,44 Litre` -- number IMMEDIATELY after the label, unit-anchored. */
const numberBeforeUnit = (text: string, label: string, unit: string): number | null => {
  const m = new RegExp(
    `${escapeRegExp(label)}\\s+((?:${TR_NUMBER}))\\s+${escapeRegExp(unit)}`,
    'i',
  ).exec(text);
  return m ? parseNum(m[1]) : null;
};

// ── provider parsers (pure, unit-tested) ────────────────────────────────────
/** open.er-api.com USD base: TRY per USD and TRY per EUR. */
export const parseOpenErRates = (data: any): { usdTry: number | null; eurTry: number | null } => {
  const rates = data?.rates;
  const usdTry = parseNum(rates?.TRY);
  const eurPerUsd = parseNum(rates?.EUR);
  const eurTry = usdTry != null && eurPerUsd != null && eurPerUsd > 0 ? usdTry / eurPerUsd : null;
  return { usdTry, eurTry };
};

const xmlTag = (xml: string, tag: string): number | null => {
  const match = new RegExp(`<${tag}>([^<]+)</${tag}>`, 'i').exec(xml);
  return match ? parseNum(match[1]) : null;
};

export const parseTcmbRate = (xml: string | null, code: 'USD' | 'EUR'): number | null => {
  if (!xml) return null;
  const block =
    new RegExp(`<Currency[^>]*CurrencyCode="${code}"[^>]*>([\\s\\S]*?)</Currency>`, 'i').exec(xml)?.[1] ?? '';
  if (!block) return null;
  return xmlTag(block, 'ForexSelling') ?? xmlTag(block, 'BanknoteSelling') ?? xmlTag(block, 'ForexBuying');
};

/**
 * bigpara gold page: "Gümüş (TL/GR) 101,199 %+0,85 ..." -- the FIRST number
 * after the exact instrument label. (The old label list only had ASCII
 * "Gumus Gram"/"GUMUS", which never matches the Turkish "Gümüş", and the old
 * number regex cut "101,199" to "101,19".)
 */
export const parseBigparaSilverGramTry = (text: string): number | null =>
  extractFirstNumberAfterLabel(text, 'Gümüş (TL/GR)', 60);

export const parseBigparaGoldGramTry = (text: string): number | null =>
  extractFirstNumberAfterLabel(text, 'ALTIN (TL/GR)', 260);

/**
 * bigpara Brent page (https://bigpara.hurriyet.com.tr/kobi/dunya-emtia-borsalari/brent-petrol/):
 * "... 104,450 %-2,02 -2,15 Alış / Satış 104,450 / 104,450 25 Eylül, 23:58:59".
 * The instrument's own "Alış / Satış" pair is the only unambiguous price; the
 * old label search matched the page title / percent-change columns and produced
 * 1.22 (a % change, not USD/barrel).
 */
export const parseBigparaBrentUsd = (text: string): number | null => {
  const m = new RegExp(
    `Alış\\s*/\\s*Satış\\s+(${TR_NUMBER})\\s*/\\s*(${TR_NUMBER})`,
    'i',
  ).exec(text);
  if (!m) return null;
  const sell = parseNum(m[2]);
  const buy = parseNum(m[1]);
  return sell ?? buy;
};

export const parseBigparaFuel = (text: string): { gasoline: number | null; diesel: number | null } => ({
  gasoline:
    numberBeforeUnit(text, 'Kurşunsuz Benzin 95 Oktan', 'Litre') ??
    extractFirstNumberAfterLabel(text, 'Kurşunsuz Benzin 95 Oktan Litre fiyatı', 140),
  diesel:
    numberBeforeUnit(text, 'Motorin', 'Litre') ??
    extractFirstNumberAfterLabel(text, 'Motorin Litre fiyatı', 140),
});

const extractTruncgil = (data: Record<string, unknown> | null, hints: string[]) => {
  if (!data) return null;
  for (const [key, value] of Object.entries(data)) {
    if (!hasHint(key, hints)) continue;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const map = value as Record<string, unknown>;
      return parseNum(map.Selling) ?? parseNum(map.Buying) ?? extractPreferredValue(map);
    }
    const num = parseNum(value);
    if (num != null) return num;
  }
  return null;
};

// ── the pipeline ────────────────────────────────────────────────────────────
export const buildMarketSnapshot = async (io: MarketIo): Promise<MarketSnapshot> => {
  const { fetchJson, fetchText, env } = io;
  const sources: Record<string, string> = {};
  const safe = async <T>(fn: () => Promise<T | null>): Promise<T | null> => {
    try {
      return await fn();
    } catch (_) {
      return null;
    }
  };

  // ── FX (USD, EUR) ─────────────────────────────────────────────────────────
  let usdTry: number | null = null;
  let eurTry: number | null = null;
  const openEr = await safe(async () => parseOpenErRates(await fetchJson('https://open.er-api.com/v6/latest/USD')));
  usdTry = inRange(openEr?.usdTry ?? null, MARKET_RANGES.fxTry);
  eurTry = inRange(openEr?.eurTry ?? null, MARKET_RANGES.fxTry);
  if (usdTry != null) sources.usd = 'open-er-api';
  if (eurTry != null) sources.eur = 'open-er-api';
  if (usdTry == null || eurTry == null) {
    const xml = await safe(() =>
      fetchText('https://www.tcmb.gov.tr/kurlar/today.xml', { headers: { accept: 'application/xml,text/xml,*/*' } }),
    );
    if (usdTry == null) {
      usdTry = inRange(parseTcmbRate(xml, 'USD'), MARKET_RANGES.fxTry);
      if (usdTry != null) sources.usd = 'tcmb';
    }
    if (eurTry == null) {
      eurTry = inRange(parseTcmbRate(xml, 'EUR'), MARKET_RANGES.fxTry);
      if (eurTry != null) sources.eur = 'tcmb';
    }
  }
  if (usdTry != null && eurTry != null) {
    // EUR/USD implied by the two rates must be plausible, else both are suspect.
    if (inRange(eurTry / usdTry, MARKET_RANGES.eurUsdCross) == null) {
      eurTry = null;
      delete sources.eur;
    }
  }

  // ── precious metals (TRY per gram) ────────────────────────────────────────
  let goldGramTry: number | null = null;
  let silverGramTry: number | null = null;
  const goldOk = (v: number | null) =>
    usdTry != null && v != null ? inRange(v / usdTry, MARKET_RANGES.goldUsdPerGram) != null : v != null && v > 0;
  const silverOk = (v: number | null) =>
    usdTry != null && v != null ? inRange(v / usdTry, MARKET_RANGES.silverUsdPerGram) != null : v != null && v > 0;
  const takeGold = (v: number | null, source: string) => {
    if (goldGramTry == null && v != null && goldOk(v)) {
      goldGramTry = v;
      sources.gold = source;
    }
  };
  const takeSilver = (v: number | null, source: string) => {
    if (silverGramTry == null && v != null && silverOk(v)) {
      silverGramTry = v;
      sources.silver = source;
    }
  };

  const goldApi = async (symbol: string) => {
    const data = await fetchJson(`https://api.gold-api.com/price/${encodeURIComponent(symbol)}`);
    return parseNum(data?.price) ?? parseNum(data?.ask) ?? parseNum(data?.bid) ?? extractPreferredValue(data);
  };

  if (usdTry != null) {
    const goldOzUsd = await safe(() => goldApi('XAU'));
    const silverOzUsd = await safe(() => goldApi('XAG'));
    if (goldOzUsd != null && goldOzUsd > 0) takeGold((goldOzUsd * usdTry) / 31.1035, 'gold-api');
    if (silverOzUsd != null && silverOzUsd > 0) takeSilver((silverOzUsd * usdTry) / 31.1035, 'gold-api');
  }
  if (goldGramTry == null || silverGramTry == null) {
    const html = await safe(() => fetchText('https://bigpara.hurriyet.com.tr/altin/gram-altin-fiyati/'));
    if (html) {
      const text = stripHtml(html);
      takeGold(parseBigparaGoldGramTry(text), 'bigpara');
      takeSilver(parseBigparaSilverGramTry(text), 'bigpara');
    }
  }
  if (goldGramTry == null || silverGramTry == null) {
    const truncgil = await safe(async () => {
      const data = await fetchJson('https://finans.truncgil.com/v4/today.json');
      return data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
    });
    takeGold(extractTruncgil(truncgil, ['gram-altin', 'gram altin', 'altin']), 'truncgil');
    takeSilver(extractTruncgil(truncgil, ['gumus', 'gram gumus', 'gumus-gr']), 'truncgil');
  }

  // ── crypto ────────────────────────────────────────────────────────────────
  let btcUsd: number | null = null;
  let ethUsd: number | null = null;
  const takeBtc = (v: number | null, s: string) => {
    if (btcUsd == null) {
      const ok = inRange(v, MARKET_RANGES.btcUsd);
      if (ok != null) {
        btcUsd = ok;
        sources.btc = s;
      }
    }
  };
  const takeEth = (v: number | null, s: string) => {
    if (ethUsd == null) {
      const ok = inRange(v, MARKET_RANGES.ethUsd);
      if (ok != null) {
        ethUsd = ok;
        sources.eth = s;
      }
    }
  };
  const cmcKey = cleanText(env.CMC_API_KEY);
  if (cmcKey) {
    const cmc = await safe(() =>
      fetchJson(
        `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${encodeURIComponent('BTC,ETH')}&convert=USD`,
        { headers: { 'X-CMC_PRO_API_KEY': cmcKey } },
      ),
    );
    takeBtc(parseNum(cmc?.data?.BTC?.quote?.USD?.price), 'coinmarketcap');
    takeEth(parseNum(cmc?.data?.ETH?.quote?.USD?.price), 'coinmarketcap');
  }
  const binance = (symbol: string) =>
    safe(async () =>
      parseNum((await fetchJson(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`))?.price),
    );
  if (btcUsd == null) takeBtc(await binance('BTCUSDT'), 'binance');
  if (ethUsd == null) takeEth(await binance('ETHUSDT'), 'binance');
  if (btcUsd == null) takeBtc(await safe(() => goldApi('BTC')), 'gold-api');
  if (ethUsd == null) takeEth(await safe(() => goldApi('ETH')), 'gold-api');
  const gecko = (id: 'bitcoin' | 'ethereum') =>
    safe(async () =>
      parseNum((await fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`))?.[id]?.usd),
    );
  if (btcUsd == null) takeBtc(await gecko('bitcoin'), 'coingecko');
  if (ethUsd == null) takeEth(await gecko('ethereum'), 'coingecko');

  // ── Brent (USD / barrel) ──────────────────────────────────────────────────
  let brentUsd: number | null = null;
  const oilUrl = cleanText(env.OIL_PRICE_API_URL);
  if (oilUrl) {
    const oilKey = cleanText(env.OIL_PRICE_API_KEY);
    const data = await safe(() =>
      fetchJson(oilUrl, { headers: oilKey ? { Authorization: `Token ${oilKey}` } : undefined }),
    );
    const v = inRange(
      parseNum(data?.price) ?? parseNum(data?.data?.price) ?? extractNamedValue(data, ['brent', 'oil', 'petrol']),
      MARKET_RANGES.brentUsd,
    );
    if (v != null) {
      brentUsd = v;
      sources.brent = 'oil-api';
    }
  }
  if (brentUsd == null) {
    const html = await safe(() =>
      fetchText('https://bigpara.hurriyet.com.tr/kobi/dunya-emtia-borsalari/brent-petrol/'),
    );
    const v = html ? inRange(parseBigparaBrentUsd(stripHtml(html)), MARKET_RANGES.brentUsd) : null;
    if (v != null) {
      brentUsd = v;
      sources.brent = 'bigpara';
    }
  }

  // ── fuel (TRY / litre) ────────────────────────────────────────────────────
  let gasolineTry: number | null = null;
  let dieselTry: number | null = null;
  const takeFuel = (g: number | null, d: number | null, source: string) => {
    const gv = inRange(g, MARKET_RANGES.fuelTryPerLitre);
    const dv = inRange(d, MARKET_RANGES.fuelTryPerLitre);
    if (gasolineTry == null && gv != null) {
      gasolineTry = gv;
      sources.gasoline = source;
    }
    if (dieselTry == null && dv != null) {
      dieselTry = dv;
      sources.diesel = source;
    }
  };
  const fuelHtml = await safe(() => fetchText('https://bigpara.hurriyet.com.tr/akaryakit-fiyatlari/'));
  if (fuelHtml) {
    const f = parseBigparaFuel(stripHtml(fuelHtml));
    takeFuel(f.gasoline, f.diesel, 'bigpara');
  }
  if (gasolineTry == null || dieselTry == null) {
    const akaryakit = async (path: string, label: string) => {
      const html = await fetchText(`https://akaryakit.org/${path}`, {
        headers: {
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
        },
      });
      if (!html) return null;
      const text = stripHtml(html);
      const m = new RegExp(`${label}\\s*([0-9]+(?:[.,][0-9]+)?)\\s*(?:₺|TL|TRY)`, 'i').exec(text)?.[1];
      return m ? parseNum(m) : null;
    };
    takeFuel(
      gasolineTry == null ? await safe(() => akaryakit('istanbul-benzin-fiyatlari', 'Benzin')) : null,
      dieselTry == null ? await safe(() => akaryakit('istanbul-motorin-fiyatlari', 'Motorin')) : null,
      'akaryakit-org',
    );
  }
  if (gasolineTry == null || dieselTry == null) {
    const board = await safe(() => fetchJson('https://api.genelpara.com/embed/akaryakit.json'));
    takeFuel(
      extractNamedValue(board, ['benzin', 'kursunsuz', 'gasoline']),
      extractNamedValue(board, ['motorin', 'mazot', 'diesel']),
      'genelpara',
    );
  }

  return {
    updatedAt: (io.now?.() ?? new Date()).toISOString(),
    usdTry,
    eurTry,
    goldGramTry,
    silverGramTry,
    fuelTry: gasolineTry,
    gasolineTry,
    dieselTry,
    brentUsd,
    btcUsd,
    ethUsd,
    sources,
  };
};
