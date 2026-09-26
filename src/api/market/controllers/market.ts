import {
  buildMarketSnapshot,
  parseNum,
  type MarketIo,
  type MarketSnapshot,
} from '../../../utils/market-snapshot';

const cleanText = (v: unknown) => String(v ?? '').trim();

const fetchJson: MarketIo['fetchJson'] = async (url, init) => {
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

const fetchText: MarketIo['fetchText'] = async (url, init) => {
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

const marketIo = (): MarketIo => ({ fetchJson, fetchText, env: process.env });

let cachedSnapshot: MarketSnapshot | null = null;
let cachedAtMs = 0;
let inflightSnapshot: Promise<MarketSnapshot> | null = null;

const marketTtlMs = () => {
  const sec = parseNum(process.env.MARKET_SNAPSHOT_TTL_SEC);
  const normalized = sec == null ? 60 : Math.max(15, Math.min(300, Math.round(sec)));
  return normalized * 1000;
};

const buildSnapshot = (): Promise<MarketSnapshot> =>
  buildMarketSnapshot(marketIo());

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
          eurTry: null,
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
