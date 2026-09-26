import type { Freshness } from './freshness';

export type RealPriceMode = 'off' | 'dry-run' | 'apply';

export const readRealPriceMode = (
  env: Record<string, string | undefined> = process.env,
): RealPriceMode => {
  const raw = String(env.AGRI_REAL_PRICE_INGESTION_MODE ?? '').trim().toLowerCase();
  return raw === 'dry-run' || raw === 'apply' ? raw : 'off';
};

/** A validated, normalised, source-attributed price observation (TRY per kg). */
export type RealPriceObservation = {
  provider: 'tobb';
  productCode: string;
  productSlug: string;
  provinceSlug: string | null;
  exchangeCode: string;
  exchangeName: string;
  observedAt: string; // ISO UTC (TOBB last-trade time, Europe/Istanbul)
  fetchedAt: string; // ISO UTC
  price: number; // = averagePrice
  averagePrice: number;
  minPrice: number;
  maxPrice: number;
  currency: 'TRY';
  unit: 'kg';
  quantity: number; // kg
  transactionCount: number;
  sourceName: string;
  marketName: string;
  sourceUrl: string;
  dedupeKey: string;
  notes: string;
  freshness: Freshness;
};

export type RejectReason =
  | 'missing-average'
  | 'price-order'
  | 'unverifiable-amount'
  | 'amount-mismatch'
  | 'unit-rejected'
  | 'invalid-date'
  | 'future-date'
  | 'too-old';

export type ProductProbe = {
  code: string;
  class: 'A' | 'B' | 'C' | 'D';
  confidence: string;
  tobbProduct: string | null;
  pageStatus: 'ok' | 'no-data' | 'error' | 'not-fetched';
  pageError?: string;
  rowsParsed: number;
  valid: number;
  rejected: Partial<Record<RejectReason, number>>;
  latestObservedAt: string | null;
};
