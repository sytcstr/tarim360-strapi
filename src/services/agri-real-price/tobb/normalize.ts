import { classifyFreshness, DEFAULT_MAX_INGEST_AGE_DAYS } from '../freshness';
import type { RealPriceObservation, RejectReason } from '../types';
import { parseIstanbulDateTime } from './dates';
import { lookupExchange, type ProductMapEntry } from './maps';
import type { TobbRawRow } from './parser';

/**
 * TOBB reports the amount (TL) of the trades behind the average. quantity x
 * average must reproduce it. Weighted vs simple averages differ a little; a
 * wrong unit (TL/ton typed as TL/kg) or a wrong quantity is off by ~1000x. The
 * tolerance is wide enough for rounding/weighting and tiny compared with any
 * unit error.
 */
export const AMOUNT_TOLERANCE = 0.25;

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

export type NormalizeContext = {
  product: ProductMapEntry;
  tobbUnit: string;
  ana: number;
  alt: number;
  tobbProductName: string;
  sourceUrl: string;
  now: Date;
  maxAgeDays?: number;
};

export type NormalizeResult =
  | { ok: true; observation: RealPriceObservation }
  | { ok: false; reason: RejectReason };

const unitFactor = (tobbUnit: string, canonical: string): { toKg: number; note: string } | null => {
  const unit = tobbUnit.trim().toUpperCase();
  if (canonical !== 'kg') return null;
  if (unit === 'KG') return { toKg: 1, note: 'unit: KG (no conversion)' };
  if (unit === 'TON') return { toKg: 1000, note: 'unit: TON -> KG (price/1000, quantity*1000)' };
  return null; // ADET, KASA, LITRE ... cannot be converted to kg exactly
};

export const normalizeTobbRow = (row: TobbRawRow, ctx: NormalizeContext): NormalizeResult => {
  const reject = (reason: RejectReason): NormalizeResult => ({ ok: false, reason });

  const factor = unitFactor(ctx.tobbUnit, ctx.product.defaultUnit);
  if (!factor) return reject('unit-rejected');
  if (row.average == null || !(row.average > 0)) return reject('missing-average');
  if (row.min == null || row.max == null || !(row.min > 0) || row.min > row.max) return reject('price-order');
  if (row.average < row.min - 1e-9 || row.average > row.max + 1e-9) return reject('price-order');
  if (
    row.quantity == null ||
    !(row.quantity > 0) ||
    row.amount == null ||
    !(row.amount > 0) ||
    row.transactionCount == null ||
    !(row.transactionCount >= 1)
  ) {
    return reject('unverifiable-amount');
  }
  const expected = row.quantity * row.average;
  if (Math.abs(expected - row.amount) / row.amount > AMOUNT_TOLERANCE) return reject('amount-mismatch');

  const date = parseIstanbulDateTime(row.lastTradeText, ctx.now);
  if (date.reason === 'invalid') return reject('invalid-date');
  if (date.reason === 'future') return reject('future-date');
  const observedAt = date.iso as string;
  const maxAge = ctx.maxAgeDays ?? DEFAULT_MAX_INGEST_AGE_DAYS;
  if (ctx.now.getTime() - new Date(observedAt).getTime() > maxAge * 86_400_000) return reject('too-old');

  const exchange = lookupExchange(row.exchangeName);
  const displayName = exchange?.displayName ?? row.exchangeName;
  const price = round(row.average / factor.toKg, 4);
  const dedupeKey = `tobb:${ctx.ana}-${ctx.alt}:${exchange?.key ?? row.exchangeCode}:${observedAt}:kg`;

  return {
    ok: true,
    observation: {
      provider: 'tobb',
      productCode: ctx.product.code,
      productSlug: ctx.product.slug,
      provinceSlug: exchange?.provinceSlug ?? null,
      exchangeCode: row.exchangeCode,
      exchangeName: displayName,
      observedAt,
      fetchedAt: ctx.now.toISOString(),
      price,
      averagePrice: price,
      minPrice: round(row.min / factor.toKg, 4),
      maxPrice: round(row.max / factor.toKg, 4),
      currency: 'TRY',
      unit: 'kg',
      quantity: round(row.quantity * factor.toKg, 3),
      transactionCount: row.transactionCount,
      sourceName: `${displayName} (TOBB)`,
      marketName: displayName,
      sourceUrl: ctx.sourceUrl,
      dedupeKey,
      notes: JSON.stringify({
        provider: 'TOBB Ticaret Borsaları Ürün Fiyat Bilgileri',
        tobbProduct: ctx.tobbProductName,
        ana_kod: ctx.ana,
        alt_kod: ctx.alt,
        exchangeCode: row.exchangeCode,
        tobbUnit: ctx.tobbUnit,
        conversion: factor.note,
        amountTry: row.amount,
      }),
      freshness: classifyFreshness(observedAt, ctx.now),
    },
  };
};
