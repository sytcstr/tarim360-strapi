const cleanText = (v: unknown) => String(v ?? '').trim();

const parseNum = (v: unknown): number | null => {
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
  const preferredKeys = [
    'selling',
    'sell',
    'price',
    'value',
    'last',
    'close',
    'rate',
    'deger',
    'amount',
  ];
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

const stripHtml = (raw: string) =>
  raw
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#252;/g, '\u00fc')
    .replace(/&#220;/g, '\u00dc')
    .replace(/&#246;/g, '\u00f6')
    .replace(/&#214;/g, '\u00d6')
    .replace(/&#231;/g, '\u00e7')
    .replace(/&#199;/g, '\u00c7')
    .replace(/&#351;/g, '\u015f')
    .replace(/&#350;/g, '\u015e')
    .replace(/&#287;/g, '\u011f')
    .replace(/&#286;/g, '\u011e')
    .replace(/\s+/g, ' ')
    .trim();

const escapeRegExp = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const extractFirstNumberAfterLabel = (
  text: string,
  label: string,
  maxWindow = 240,
): number | null => {
  const pattern = new RegExp(`${escapeRegExp(label)}([\\s\\S]{0,${maxWindow}})`, 'gi');
  for (const match of text.matchAll(pattern)) {
    const segment = match[1] ?? '';
    const raw = segment.match(/[0-9]{1,3}(?:\.[0-9]{3})*,[0-9]{2}/)?.[0] ?? null;
    const num = parseNum(raw);
    if (num != null) return num;
  }
  return null;
};

const fetchJson = async (url: string, init?: RequestInit): Promise<any | null> => {
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        accept: 'application/json,*/*',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  }
};

const fetchText = async (url: string, init?: RequestInit): Promise<string | null> => {
  try {
    const res = await fetch(url, {
      ...init,
      headers: {
        'cache-control': 'no-cache',
        pragma: 'no-cache',
        accept: 'text/plain,text/html,application/xml,*/*',
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch (_) {
    return null;
  }
};

const extractXmlTagValue = (xml: string, tag: string): number | null => {
  const match = new RegExp(`<${tag}>([^<]+)</${tag}>`, 'i').exec(xml);
  return match ? parseNum(match[1]) : null;
};

const fetchTruncgilSnapshot = async () => {
  const data = await fetchJson('https://finans.truncgil.com/v4/today.json');
  if (!data || typeof data !== 'object') return null;
  return data as Record<string, unknown>;
};

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

const fetchTcmbUsdTry = async () => {
  const xml = await fetchText('https://www.tcmb.gov.tr/kurlar/today.xml', {
    headers: { accept: 'application/xml,text/xml,*/*' },
  });
  if (!xml) return null;
  const block = /<Currency[^>]*CurrencyCode="USD"[^>]*>([\s\S]*?)<\/Currency>/i.exec(xml)?.[1] ?? '';
  if (!block) return null;
  return (
    extractXmlTagValue(block, 'ForexSelling') ??
    extractXmlTagValue(block, 'BanknoteSelling') ??
    extractXmlTagValue(block, 'ForexBuying')
  );
};

const fetchOpenErUsdTry = async () => {
  const data = await fetchJson('https://open.er-api.com/v6/latest/USD');
  return parseNum(data?.rates?.TRY);
};

const fetchCoinMarketCap = async (symbols: string[]) => {
  const apiKey = cleanText(process.env.CMC_API_KEY);
  if (!apiKey) return null;
  const qs = encodeURIComponent(symbols.join(','));
  const data = await fetchJson(
    `https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest?symbol=${qs}&convert=USD`,
    { headers: { 'X-CMC_PRO_API_KEY': apiKey } },
  );
  return data && typeof data === 'object' ? data : null;
};

const extractCoinMarketCapUsd = (data: any, symbol: string): number | null => {
  const body = data?.data?.[symbol]?.quote?.USD;
  return parseNum(body?.price);
};

const fetchGoldApiPrice = async (symbol: string) => {
  const data = await fetchJson(`https://api.gold-api.com/price/${encodeURIComponent(symbol)}`);
  return parseNum(data?.price) ?? parseNum(data?.ask) ?? parseNum(data?.bid) ?? extractPreferredValue(data);
};

const fetchBinanceUsdTicker = async (symbol: string) => {
  const data = await fetchJson(
    `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`,
  );
  return parseNum(data?.price);
};

const fetchCoinGeckoUsd = async (id: 'bitcoin' | 'ethereum') => {
  const data = await fetchJson(
    `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
  );
  return parseNum(data?.[id]?.usd);
};

const fetchBigparaGoldSilver = async () => {
  const html = await fetchText('https://bigpara.hurriyet.com.tr/altin/gram-altin-fiyati/');
  if (!html) return { gold: null, silver: null };
  const text = stripHtml(html);
  const gold = extractFirstNumberAfterLabel(text, 'ALTIN (TL/GR)', 260);
  const silver =
    extractFirstNumberAfterLabel(text, 'Gumus Gram', 180) ??
    extractFirstNumberAfterLabel(text, 'GUMUS', 180);
  return { gold, silver };
};

const fetchBigparaFuelBoard = async () => {
  const html = await fetchText('https://bigpara.hurriyet.com.tr/akaryakit-fiyatlari/');
  if (!html) return { gasoline: null, diesel: null };
  const text = stripHtml(html);
  const gasoline =
    extractFirstNumberAfterLabel(text, 'Kurşunsuz Benzin 95 Oktan', 220) ??
    extractFirstNumberAfterLabel(text, 'Kurşunsuz Benzin 95 Oktan Litre fiyatı', 140);
  const diesel =
    extractFirstNumberAfterLabel(text, 'Motorin', 180) ??
    extractFirstNumberAfterLabel(text, 'Motorin Litre fiyatı', 140) ??
    extractFirstNumberAfterLabel(text, 'Mazot', 140);
  return { gasoline, diesel };
};

const fetchBigparaBrent = async () => {
  const html = await fetchText('https://bigpara.hurriyet.com.tr/kobi/dunya-emtia-borsalari/BRENT/');
  if (!html) return null;
  const text = stripHtml(html);
  return (
    extractFirstNumberAfterLabel(text, 'BRENT PETROL ALIŞ($)', 80) ??
    extractFirstNumberAfterLabel(text, 'BRENT PETROL', 180)
  );
};

const fetchAkaryakitPrice = async ({
  path,
  label,
  brand,
}: {
  path: string;
  label: string;
  brand: string;
}) => {
  const html = await fetchText(`https://akaryakit.org/${path}`, {
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
    },
  });
  if (!html) return null;
  const text = stripHtml(html);
  const summary = new RegExp(
    `${label}\\s*([0-9]+(?:[.,][0-9]+)?)\\s*(?:₺|TL|TRY)`,
    'i',
  ).exec(text)?.[1];
  if (summary) return parseNum(summary);
  const brandMatch = new RegExp(`${brand}\\s*([0-9]+(?:[.,][0-9]+)?)`, 'i').exec(
    text,
  )?.[1];
  if (brandMatch) return parseNum(brandMatch);
  return null;
};

const fetchIstanbulGasoline = async () =>
  fetchAkaryakitPrice({
    path: 'istanbul-benzin-fiyatlari',
    label: 'Benzin',
    brand: 'PETROL OFISI',
  });

const fetchIstanbulDiesel = async () =>
  fetchAkaryakitPrice({
    path: 'istanbul-motorin-fiyatlari',
    label: 'Motorin',
    brand: 'PETROL OFISI',
  });

const fetchFuelBoard = async () =>
  fetchJson('https://api.genelpara.com/embed/akaryakit.json');

const fetchGlobalOil = async () => {
  const oilUrl = cleanText(process.env.OIL_PRICE_API_URL);
  const oilKey = cleanText(process.env.OIL_PRICE_API_KEY);
  if (!oilUrl) return null;
  const data = await fetchJson(oilUrl, {
    headers: oilKey ? { Authorization: `Token ${oilKey}` } : undefined,
  });
  return (
    parseNum(data?.price) ??
    parseNum(data?.data?.price) ??
    extractNamedValue(data, ['brent', 'oil', 'petrol'])
  );
};

type MarketSnapshot = {
  updatedAt: string;
  usdTry: number | null;
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

let cachedSnapshot: MarketSnapshot | null = null;
let cachedAtMs = 0;
let inflightSnapshot: Promise<MarketSnapshot> | null = null;

const marketTtlMs = () => {
  const sec = parseNum(process.env.MARKET_SNAPSHOT_TTL_SEC);
  const normalized = sec == null ? 60 : Math.max(15, Math.min(300, Math.round(sec)));
  return normalized * 1000;
};

const buildSnapshot = async (): Promise<MarketSnapshot> => {
  let usdTry: number | null = null;
  let goldGramTry: number | null = null;
  let silverGramTry: number | null = null;
  let gasolineTry: number | null = null;
  let dieselTry: number | null = null;
  let brentUsd: number | null = null;
  let btcUsd: number | null = null;
  let ethUsd: number | null = null;
  const sources: Record<string, string> = {};

  usdTry = await fetchOpenErUsdTry();
  if (usdTry != null) sources.usd = 'open-er-api';

  usdTry ??= await fetchTcmbUsdTry();
  if (usdTry != null && !sources.usd) sources.usd = 'tcmb';

  if (usdTry != null) {
    const goldOzUsd = await fetchGoldApiPrice('XAU');
    const silverOzUsd = await fetchGoldApiPrice('XAG');
    if (goldOzUsd != null) {
      goldGramTry = (goldOzUsd * usdTry) / 31.1035;
      sources.gold = 'gold-api';
    }
    if (silverOzUsd != null) {
      silverGramTry = (silverOzUsd * usdTry) / 31.1035;
      sources.silver = 'gold-api';
    }
  }

  if (goldGramTry == null || silverGramTry == null) {
    const bigparaMetals = await fetchBigparaGoldSilver();
    goldGramTry ??= bigparaMetals.gold;
    silverGramTry ??= bigparaMetals.silver;
    if (goldGramTry != null && !sources.gold) sources.gold = 'bigpara';
    if (silverGramTry != null && !sources.silver) sources.silver = 'bigpara';
  }

  if (goldGramTry == null || silverGramTry == null) {
    const truncgil = await fetchTruncgilSnapshot();
    goldGramTry ??= extractTruncgil(truncgil, ['gram-altin', 'gram altin', 'altin']);
    silverGramTry ??= extractTruncgil(truncgil, ['gumus', 'gram gumus', 'gumus-gr']);
    if (goldGramTry != null && !sources.gold) sources.gold = 'truncgil';
    if (silverGramTry != null && !sources.silver) sources.silver = 'truncgil';
  }

  const cmc = await fetchCoinMarketCap(['BTC', 'ETH']);
  btcUsd = extractCoinMarketCapUsd(cmc, 'BTC');
  ethUsd = extractCoinMarketCapUsd(cmc, 'ETH');
  if (btcUsd != null) sources.btc = 'coinmarketcap';
  if (ethUsd != null) sources.eth = 'coinmarketcap';

  btcUsd ??= await fetchBinanceUsdTicker('BTCUSDT');
  if (btcUsd != null && !sources.btc) sources.btc = 'binance';
  ethUsd ??= await fetchBinanceUsdTicker('ETHUSDT');
  if (ethUsd != null && !sources.eth) sources.eth = 'binance';

  btcUsd ??= await fetchGoldApiPrice('BTC');
  if (btcUsd != null && !sources.btc) sources.btc = 'gold-api';
  ethUsd ??= await fetchGoldApiPrice('ETH');
  if (ethUsd != null && !sources.eth) sources.eth = 'gold-api';

  btcUsd ??= await fetchCoinGeckoUsd('bitcoin');
  if (btcUsd != null && !sources.btc) sources.btc = 'coingecko';
  ethUsd ??= await fetchCoinGeckoUsd('ethereum');
  if (ethUsd != null && !sources.eth) sources.eth = 'coingecko';

  brentUsd = await fetchGlobalOil();
  if (brentUsd != null) sources.brent = 'oil-api';
  brentUsd ??= await fetchBigparaBrent();
  if (brentUsd != null && !sources.brent) sources.brent = 'bigpara';

  const bigparaFuel = await fetchBigparaFuelBoard();
  gasolineTry = bigparaFuel.gasoline;
  dieselTry = bigparaFuel.diesel;
  if (gasolineTry != null) sources.gasoline = 'bigpara';
  if (dieselTry != null) sources.diesel = 'bigpara';

  gasolineTry ??= await fetchIstanbulGasoline();
  if (gasolineTry != null && !sources.gasoline) sources.gasoline = 'akaryakit-org';
  dieselTry ??= await fetchIstanbulDiesel();
  if (dieselTry != null && !sources.diesel) sources.diesel = 'akaryakit-org';

  if (gasolineTry == null || dieselTry == null) {
    const fuelBoard = await fetchFuelBoard();
    gasolineTry ??= extractNamedValue(fuelBoard, ['benzin', 'kursunsuz', 'gasoline']);
    dieselTry ??= extractNamedValue(fuelBoard, ['motorin', 'mazot', 'diesel']);
    if (gasolineTry != null && !sources.gasoline) sources.gasoline = 'genelpara';
    if (dieselTry != null && !sources.diesel) sources.diesel = 'genelpara';
  }

  return {
    updatedAt: new Date().toISOString(),
    usdTry,
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

const getSnapshot = async (force = false): Promise<MarketSnapshot> => {
  const now = Date.now();
  const ttlMs = marketTtlMs();
  if (!force && cachedSnapshot != null && now - cachedAtMs < ttlMs) {
    return {
      ...cachedSnapshot,
      cached: true,
      cacheAgeSec: Math.max(0, Math.floor((now - cachedAtMs) / 1000)),
    };
  }

  if (inflightSnapshot != null) {
    const snapshot = await inflightSnapshot;
    return {
      ...snapshot,
      cached: cachedSnapshot != null,
      cacheAgeSec: Math.max(0, Math.floor((Date.now() - cachedAtMs) / 1000)),
    };
  }

  inflightSnapshot = buildSnapshot()
    .then((snapshot) => {
      cachedSnapshot = snapshot;
      cachedAtMs = Date.now();
      return snapshot;
    })
    .finally(() => {
      inflightSnapshot = null;
    });

  const snapshot = await inflightSnapshot;
  return {
    ...snapshot,
    cached: false,
    cacheAgeSec: 0,
  };
};

export default {
  async snapshot(ctx) {
    try {
      const force = cleanText(ctx.query?.force) === '1';
      const snapshot = await getSnapshot(force);
      ctx.body = { ok: true, snapshot };
    } catch (error) {
      console.error('market snapshot failed', error);
      if (cachedSnapshot != null) {
        ctx.body = {
          ok: true,
          snapshot: {
            ...cachedSnapshot,
            cached: true,
            cacheAgeSec: Math.max(0, Math.floor((Date.now() - cachedAtMs) / 1000)),
          },
        };
        return;
      }
      ctx.body = {
        ok: false,
        snapshot: {
          updatedAt: new Date().toISOString(),
          usdTry: null,
          goldGramTry: null,
          silverGramTry: null,
          fuelTry: null,
          gasolineTry: null,
          dieselTry: null,
          brentUsd: null,
          btcUsd: null,
          ethUsd: null,
          sources: {},
          cached: false,
          cacheAgeSec: 0,
        },
      };
    }
  },
};
