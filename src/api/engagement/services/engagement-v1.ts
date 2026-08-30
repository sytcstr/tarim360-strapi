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
import { incrementCounterAtomic, resolveTargetRow } from './engagement-core';

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
    const targetId = String(target.id);

    const existing = await strapiInstance.db.query(INTERACTION_UID).findOne({
      where: { actorKey, targetType, targetId, kind },
    });
    const alreadyActive = !!existing;

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
