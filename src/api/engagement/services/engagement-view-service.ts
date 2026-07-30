/**
 * View service logic for the Engagement API contract v1
 * (ENGAGEMENT_API_CONTRACT.md §4.3 — "son görüntülenme kaydı" model,
 * Aşama 5). Unlike like/favorite, a view is never "undone" — the
 * engagement-view row is a single, continuously-refreshed record per
 * (actorKey, targetType, targetId), not a create/delete membership.
 *
 * No row lock is used (SELECT...FOR UPDATE is a confirmed no-op on this
 * project's SQLite dialect, see ENGAGEMENT_API_CONTRACT.md §3.3).
 * Safety instead comes from: (1) a conditional UPDATE...WHERE
 * (lastViewedAt <= cutoff) whose affected-row-count tells us unambiguously
 * whether the refresh actually applied, and (2) the composite unique
 * constraint on the view row for the not-yet-exists case, with
 * insert-conflict treated as "someone else already recorded it, count as
 * fresh" — exactly mirroring the membership service's pattern in
 * engagement-v1.ts.
 */
import { VIEW_COUNT_FIELD, VERSION_FIELD, EngagementTargetType, TARGET_COLLECTION } from '../../../utils/engagement-contract';
import { incrementCounterAtomic, resolveTargetRow } from './engagement-core';

const VIEW_UID = 'api::engagement-view.engagement-view';
const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000; // rolling 24h, not calendar day — contract §4.3

export interface ViewResult {
  found: boolean;
  incremented: boolean;
  count: number;
  updatedAt: string;
  serverVersion: number;
}

export const registerView = async (
  strapiInstance: any,
  actorKey: string,
  targetType: EngagementTargetType,
  rawTargetId: string,
): Promise<ViewResult> => {
  const collectionName = TARGET_COLLECTION[targetType];
  const viewField = VIEW_COUNT_FIELD[targetType];
  if (!viewField) {
    throw new Error(`No view field configured for ${targetType}`);
  }

  return strapiInstance.db.transaction(async ({ trx }: { trx: any }) => {
    const target = await resolveTargetRow(strapiInstance, targetType, rawTargetId);
    if (!target) {
      return { found: false, incremented: false, count: 0, updatedAt: '', serverVersion: 0 };
    }
    const targetId = String(target.id);
    const nowIso = new Date().toISOString();
    const cutoffIso = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString();

    const currentCount = Math.max(0, Number(target[viewField] ?? 0));
    const currentVersion = Number(target[VERSION_FIELD] ?? 0);
    const currentUpdatedAt = target.updatedAt ?? nowIso;

    // Step 1: conditional refresh — only affects a row if it exists AND
    // is stale (>= 24h old). The affected count is the unambiguous signal.
    const refreshed = await strapiInstance.db.query(VIEW_UID).updateMany({
      where: { actorKey, targetType, targetId, lastViewedAt: { $lte: cutoffIso } },
      data: { lastViewedAt: nowIso },
    });

    let shouldIncrement = refreshed.count > 0;

    if (!shouldIncrement) {
      const existing = await strapiInstance.db.query(VIEW_UID).findOne({
        where: { actorKey, targetType, targetId },
      });
      if (!existing) {
        // Step 2: no row at all yet — first-ever view from this actor.
        try {
          await strapiInstance.db.query(VIEW_UID).create({
            data: { actorKey, targetType, targetId, lastViewedAt: nowIso },
          });
          shouldIncrement = true;
        } catch (e) {
          // Unique constraint conflict: a concurrent request just inserted
          // the same row first. Treat as already-fresh, don't increment —
          // matches the membership service's insert-conflict handling.
          shouldIncrement = false;
        }
      }
      // else: row exists and is still within the 24h window — no-op.
    }

    if (!shouldIncrement) {
      return {
        found: true,
        incremented: false,
        count: currentCount,
        updatedAt: currentUpdatedAt,
        serverVersion: currentVersion,
      };
    }

    const updated = await incrementCounterAtomic(trx, collectionName, target.id, viewField, 1);
    return {
      found: true,
      incremented: true,
      count: updated.count,
      updatedAt: updated.updatedAt,
      serverVersion: updated.serverVersion,
    };
  });
};
