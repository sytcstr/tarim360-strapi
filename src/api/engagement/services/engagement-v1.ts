/**
 * Core service logic for the Engagement API contract v1
 * (ENGAGEMENT_API_CONTRACT.md). Controllers stay thin; all transaction /
 * atomicity / interaction-identity logic lives here so it is exercised
 * identically regardless of which route (new /engagements/* or a
 * delegating legacy route, see Aşama 10) calls it.
 */
import { loadEntityByRouteId } from '../../../utils/identity';
import {
  COUNTER_FIELD,
  EngagementMembershipKind,
  EngagementTargetType,
  TARGET_COLLECTION,
  TARGET_UID,
  VERSION_FIELD,
} from '../../../utils/engagement-contract';

const INTERACTION_UID = 'api::engagement-interaction.engagement-interaction';

/** camelCase Strapi attribute name -> actual snake_case DB column name.
 * Verified empirically against the local dev SQLite DB (read-only
 * inspection, e.g. `ownerProfileId` -> `owner_profile_id`,
 * `viewCount` -> `view_count`) — this is Strapi's standard, consistent
 * naming convention, not a guess. */
const toSnakeCase = (value: string): string =>
  value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

export interface MembershipResult {
  found: boolean;
  active: boolean;
  changed: boolean;
  count: number;
  updatedAt: string;
  serverVersion: number;
}

const resolveTargetRow = async (
  strapiInstance: any,
  targetType: EngagementTargetType,
  rawTargetId: string,
): Promise<Record<string, any> | null> => {
  const uid = TARGET_UID[targetType];
  return loadEntityByRouteId(strapiInstance, uid, rawTargetId, ['id', 'documentId']);
};

/**
 * Single atomic UPDATE: increments (or floor-clamped decrements) the
 * counter field and engagementVersion together, in one SQL statement, no
 * row-lock required (see ENGAGEMENT_API_CONTRACT.md §3.3 — SELECT...FOR
 * UPDATE is a confirmed no-op on this project's SQLite dialect).
 */
const incrementCounterAtomic = async (
  trx: any,
  collectionName: string,
  id: number,
  countField: string,
  delta: 1 | -1,
): Promise<{ count: number; serverVersion: number; updatedAt: string }> => {
  const countCol = toSnakeCase(countField);
  const versionCol = toSnakeCase(VERSION_FIELD);
  const setClause =
    delta > 0
      ? {
          [countCol]: trx.raw(`?? + 1`, [countCol]),
          [versionCol]: trx.raw(`?? + 1`, [versionCol]),
        }
      : {
          [countCol]: trx.raw(`MAX(?? - 1, 0)`, [countCol]),
          [versionCol]: trx.raw(`?? + 1`, [versionCol]),
        };
  await trx(collectionName).where('id', id).update(setClause);
  const row = await trx(collectionName).where('id', id).first(countCol, versionCol, 'updated_at');
  return {
    count: Number(row?.[countCol] ?? 0),
    serverVersion: Number(row?.[versionCol] ?? 0),
    updatedAt: row?.updated_at ?? new Date().toISOString(),
  };
};

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

export const isMembershipActive = async (
  strapiInstance: any,
  actorKey: string,
  targetType: EngagementTargetType,
  rawTargetId: string,
  kind: EngagementMembershipKind,
): Promise<boolean> => {
  const target = await resolveTargetRow(strapiInstance, targetType, rawTargetId);
  if (!target) return false;
  const existing = await strapiInstance.db.query(INTERACTION_UID).findOne({
    where: { actorKey, targetType, targetId: String(target.id), kind },
  });
  return !!existing;
};
