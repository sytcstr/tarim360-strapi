import { createHash } from 'node:crypto';
import type { AgriCurrency, AgriPriceRecord } from './types';

const currencies = new Set<AgriCurrency>(['TRY', 'USD', 'EUR']);

const cleanText = (value: unknown): string => String(value ?? '').trim();

export const normalizeLookupText = (value: unknown): string =>
  cleanText(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export const toAgriSlug = (value: unknown): string =>
  normalizeLookupText(value).replace(/\s+/g, '-');

const toPrice = (value: unknown, field: string): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${field} must be a non-negative finite number`);
  }
  return parsed;
};

export const normalizeAgriPriceRecord = (
  input: AgriPriceRecord,
): AgriPriceRecord => {
  const productName = cleanText(input.productName);
  const sourceName = cleanText(input.sourceName);
  const unit = cleanText(input.unit);
  if (!productName || !sourceName || !unit) {
    throw new Error('productName, sourceName and unit are required');
  }

  const date = new Date(input.observedAt);
  if (Number.isNaN(date.getTime())) {
    throw new Error('observedAt must be a valid date');
  }

  let minPrice = toPrice(input.minPrice, 'minPrice');
  let maxPrice = toPrice(input.maxPrice, 'maxPrice');
  if (minPrice > maxPrice) [minPrice, maxPrice] = [maxPrice, minPrice];
  const averagePrice = toPrice(input.averagePrice, 'averagePrice');
  const confidence = Number(input.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('confidence must be between 0 and 1');
  }

  const currency = cleanText(input.currency).toUpperCase() as AgriCurrency;
  if (!currencies.has(currency)) {
    throw new Error(`Unsupported currency: ${currency}`);
  }

  return {
    productName,
    provinceName: cleanText(input.provinceName),
    minPrice,
    maxPrice,
    averagePrice,
    currency,
    unit,
    observedAt: date.toISOString(),
    sourceName,
    sourceUrl: cleanText(input.sourceUrl),
    confidence,
  };
};

export const buildAgriDedupeKey = (record: AgriPriceRecord): string => {
  const identity = [
    normalizeLookupText(record.productName),
    normalizeLookupText(record.provinceName) || 'national',
    normalizeLookupText(record.sourceName),
    new Date(record.observedAt).toISOString(),
  ].join('|');
  return createHash('sha256').update(identity).digest('hex');
};
