/**
 * TOBB shows "25.09.2026 12:31" in Turkish local time. Turkey has used a fixed
 * UTC+03:00 offset since 2016 (no DST), so a fixed offset is exact for every
 * current observation. Calendar-invalid dates and future dates are rejected.
 */
const TR_DATE_TIME = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})$/;
const ISTANBUL_OFFSET_MINUTES = 180;
export const FUTURE_TOLERANCE_MS = 10 * 60_000;

export type ParsedDate = { iso: string | null; reason: 'invalid' | 'future' | null };

export const parseIstanbulDateTime = (raw: unknown, now: Date): ParsedDate => {
  const m = TR_DATE_TIME.exec(String(raw ?? '').trim());
  if (!m) return { iso: null, reason: 'invalid' };
  const [day, month, year, hour, minute] = m.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) {
    return { iso: null, reason: 'invalid' };
  }
  const utc = Date.UTC(year, month - 1, day, hour, minute) - ISTANBUL_OFFSET_MINUTES * 60_000;
  const check = new Date(utc + ISTANBUL_OFFSET_MINUTES * 60_000);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return { iso: null, reason: 'invalid' };
  }
  if (utc > now.getTime() + FUTURE_TOLERANCE_MS) return { iso: null, reason: 'future' };
  return { iso: new Date(utc).toISOString(), reason: null };
};
