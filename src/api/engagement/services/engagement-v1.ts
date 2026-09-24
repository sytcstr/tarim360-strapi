/**
 * Core service logic for the Engagement API contract v1
 * (ENGAGEMENT_API_CONTRACT.md). Controllers stay thin; all transaction /
 * atomicity / interaction-identity logic lives here so it is exercised
 * identically regardless of which route (new /engagements/* or a
 * delegating legacy route, see Aşama 10) calls it.
 */
import {
  COUNTER_FIELD,
  EngagementMembershipKind,
  EngagementTargetType,
  TARGET_COLLECTION,
  VERSION_FIELD,
} from '../../../utils/engagement-contract';
import { engagementRecordKeys, incrementCounterAtomic, resolveTargetRow } from './engagement-core';

const INTERACTION_UID = 'api::engagement-interaction.engagement-interaction';

export interface MembershipResult {
  found: boolean;
  active: boolean;
  changed: boolean;
  count: number;
  updatedAt: string;
  serverVersion: number;
}

/**
 * PUT (active=true) / DELETE (active=false) for like/favorite —
 * ENGAGEMENT_API_CONTRACT.md §3.1. Naturally idempotent: repeating the
 * same call after it already succeeded returns changed:false with the
 * same `active` value, never toggles back.
 */
export const setMembership = async (
  strapiInstance: any,
  actorKey: string,
  targetType: EngagementTargetType,
  rawTargetId: string,
  kind: EngagementMembershipKind,
  active: boolean,
): Promise<MembershipResult> => {
  const collectionName = TARGET_COLLECTION[targetType];
  const countField = COUNTER_FIELD[targetType]?.[kind];
  if (!countField) {
    throw new Error(`No counter field configured for ${targetType}.${kind}`);
  }

  return strapiInstance.db.transaction(async ({ trx }: { trx: any }) => {
    const target = await resolveTargetRow(strapiInstance, targetType, rawTargetId);
    if (!target) {
      return { found: false, active: false, changed: false, count: 0, updatedAt: '', serverVersion: 0 };
    }
    // Keyed by the listing's stable documentId (its numeric id changes on
    // every publish); rows written under the legacy numeric key are still
    // found and adopted, so nothing recorded before this change is lost.
    const { key: targetId, both: targetIdKeys } = engagementRecordKeys(target, targetType);

    const existing = await strapiInstance.db.query(INTERACTION_UID).findOne({
      where: { actorKey, targetType, targetId: { $in: targetIdKeys }, kind },
    });
    const alreadyActive = !!existing;
    if (existing && existing.targetId !== targetId) {
      try {
        await strapiInstance.db.query(INTERACTION_UID).update({
          where: { id: existing.id },
          data: { targetId },
        });
      } catch (_e) {
        // A concurrent request already wrote the stable-key row; harmless.
      }
    }

    const currentCount = Math.max(0, Number(target[countField] ?? 0));
    const currentVersion = Number(target[VERSION_FIELD] ?? 0);
    const currentUpdatedAt = target.updatedAt ?? new Date().toISOString();

    if (active === alreadyActive) {
      // Already in the desired state — no-op, not idempotent-noise.
      return {
        found: true,
        active,
        changed: false,
        count: currentCount,
        updatedAt: currentUpdatedAt,
        serverVersion: currentVersion,
      };
    }

    if (active) {
      try {
        await strapiInstance.db.query(INTERACTION_UID).create({
          data: { actorKey, targetType, targetId, kind },
        });
      } catch (e) {
        // Composite unique constraint conflict: another concurrent request
        // already inserted the same (actorKey,targetType,targetId,kind).
        // Treat as already active rather than erroring — this is exactly
        // what makes concurrent PUTs safe without a row lock.
        return {
          found: true,
          active: true,
          changed: false,
          count: currentCount,
          updatedAt: currentUpdatedAt,
          serverVersion: currentVersion,
        };
      }
    } else {
      if (existing) {
        await strapiInstance.db.query(INTERACTION_UID).delete({ where: { id: existing.id } });
      }
    }

    const updated = await incrementCounterAtomic(
      trx,
      collectionName,
      target.id,
      countField,
      active ? 1 : -1,
      target.documentId,
    );

    return {
      found: true,
      active,
      changed: true,
      count: updated.count,
      updatedAt: updated.updatedAt,
      serverVersion: updated.serverVersion,
    };
  });
};
