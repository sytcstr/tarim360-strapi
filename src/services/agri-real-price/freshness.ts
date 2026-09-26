/**
 * Freshness classes for a real observation. The PRICE is never changed by
 * freshness: an observation always keeps its own real observedAt.
 */
export const FRESHNESS_THRESHOLDS = {
  /** <= this many days old: fresh */
  freshDays: 7,
  /** <= this many days old (and > freshDays): stale; older: very_stale */
  staleDays: 30,
} as const;

/** Rows older than this are not ingested at all (they would be shown as the latest price). */
export const DEFAULT_MAX_INGEST_AGE_DAYS = 60;

export type Freshness = 'fresh' | 'stale' | 'very_stale';

const DAY_MS = 86_400_000;

export const classifyFreshness = (observedAtIso: string, now: Date): Freshness => {
  const ageDays = (now.getTime() - new Date(observedAtIso).getTime()) / DAY_MS;
  if (ageDays <= FRESHNESS_THRESHOLDS.freshDays) return 'fresh';
  if (ageDays <= FRESHNESS_THRESHOLDS.staleDays) return 'stale';
  return 'very_stale';
};
