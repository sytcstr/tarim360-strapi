import productMapJson from '../../../seeds/data/tobb-product-map.json';
import exchangeMapJson from '../../../seeds/data/tobb-exchange-province-map.json';

export type TobbCandidate = { ana: number; alt: number; name: string };
export type ProductMapEntry = {
  code: string;
  slug: string;
  name: string;
  category: string;
  defaultUnit: string;
  class: 'A' | 'B' | 'C' | 'D';
  confidence: 'EXACT' | 'SAFE_ALIAS' | 'AMBIGUOUS' | 'NO_MATCH';
  tobb: TobbCandidate | null;
  candidates: TobbCandidate[];
  notes: string;
};
export type ExchangeMapEntry = {
  code: string;
  name: string;
  key: string;
  provinceSlug: string | null;
  displayName: string;
};

export const productMap: ProductMapEntry[] = productMapJson as ProductMapEntry[];
export const exchangeMap: ExchangeMapEntry[] = exchangeMapJson as ExchangeMapEntry[];

/** Only EXACT / SAFE_ALIAS entries with a single TOBB item are ingested. */
export const autoIngestProducts = (): ProductMapEntry[] =>
  productMap.filter((p) => p.tobb != null && (p.confidence === 'EXACT' || p.confidence === 'SAFE_ALIAS'));

const fold = (s: string) =>
  String(s)
    .toLocaleUpperCase('tr-TR')
    .replace(/İ/g, 'I')
    .replace(/Ş/g, 'S')
    .replace(/Ğ/g, 'G')
    .replace(/Ü/g, 'U')
    .replace(/Ö/g, 'O')
    .replace(/Ç/g, 'C')
    .replace(/\s+/g, ' ')
    .trim();

/** "CORUM TICARET BORSASI" / "ILGIN TİCARET BORSASI" -> "CORUM" / "ILGIN". */
export const exchangeKey = (name: string): string =>
  fold(name).replace(/ TICARET BORSASI$/, '').trim();

const byKey = new Map(exchangeMap.map((e) => [e.key, e]));

/** Deterministic exchange -> province lookup (exact key match, never substring). */
export const lookupExchange = (name: string): ExchangeMapEntry | null => byKey.get(exchangeKey(name)) ?? null;
