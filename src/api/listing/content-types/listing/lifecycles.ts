/**
 * LISTING_L10_PREMIUM_ROCKET_CONSISTENCY_REPORT.md L10.4/L10.9: `isDoping`
 * is set to `true` exactly once, by `activateRocket`
 * (listing/controllers/listing.ts) -- nothing anywhere in this codebase
 * ever flips it back to `false` once `rocketEndsAt` passes (confirmed:
 * no cron task, no other lifecycle, no read-time transform existed
 * before this file). Every API consumer -- not just the Flutter app,
 * which already re-derives an expiry-aware value client-side via
 * `isDopingListing()` from `rocketEndsAt` alone -- would otherwise see a
 * stale `isDoping: true` forever for any listing that was ever
 * rocketed, regardless of how long ago it expired.
 *
 * Fixed here as a read-time, non-destructive override (not a cron/
 * timer): the DB row itself is never rewritten, only the in-memory
 * result object served to the caller. `rocketEndsAt` is left completely
 * untouched either way, so any consumer (including Flutter's own
 * existing expiry check) that derives its own "is this still rocketed"
 * answer from `rocketEndsAt` directly continues to work identically.
 */
const applyEffectiveRocketState = (row: unknown): void => {
  if (!row || typeof row !== 'object') return;
  const record = row as Record<string, unknown>;
  if (record.isDoping !== true) return;
  const endsAt = new Date(String(record.rocketEndsAt ?? '')).getTime();
  if (!Number.isFinite(endsAt)) return;
  if (endsAt <= Date.now()) {
    record.isDoping = false;
  }
};

export default {
  afterFindOne(event: any) {
    applyEffectiveRocketState(event?.result);
  },

  afterFindMany(event: any) {
    const result = event?.result;
    if (Array.isArray(result)) {
      for (const row of result) applyEffectiveRocketState(row);
    }
  },
};
