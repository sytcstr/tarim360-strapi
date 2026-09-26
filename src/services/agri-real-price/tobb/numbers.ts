/**
 * Turkish number format used by TOBB: '.' is the THOUSANDS separator and ','
 * the decimal separator (36,830 / 13.420,50 / 1.727.910,00 / 19.000 / 382).
 * Strict: anything that is not exactly that shape is rejected (null), never
 * guessed.
 */
const TR_NUMBER = /^(?:[0-9]{1,3}(?:\.[0-9]{3})+|[0-9]+)(?:,[0-9]+)?$/;

export const parseTurkishNumber = (raw: unknown): number | null => {
  const text = String(raw ?? '').replace(/ /g, ' ').trim();
  if (!TR_NUMBER.test(text)) return null;
  const value = Number(text.replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(value) ? value : null;
};
