/**
 * Shared low-level helpers used by both the membership (like/favorite,
 * engagement-v1.ts) and view (engagement-view-service.ts) service logic.
 * Kept separate so neither file needs to duplicate target resolution or
 * the atomic counter-increment statement.
 */
import { loadEntityByRouteId } from '../../../utils/identity';
import { EngagementTargetType, TARGET_UID, VERSION_FIELD } from '../../../utils/engagement-contract';

export const resolveTargetRow = async (
  strapiInstance: any,
  targetType: EngagementTargetType,
  rawTargetId: string,
): Promise<Record<string, any> | null> => {
  const uid = TARGET_UID[targetType];
  return loadEntityByRouteId(strapiInstance, uid, rawTargetId, ['id', 'documentId']);
};

/** camelCase Strapi attribute name -> actual snake_case DB column name.
 * Verified empirically against the local dev SQLite DB (read-only
 * inspection, e.g. `ownerProfileId` -> `owner_profile_id`,
 * `viewCount` -> `view_count`) — Strapi's standard, consistent naming
 * convention, not a guess. */
export const toSnakeCase = (value: string): string =>
  value.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/**
 * Single atomic UPDATE: increments (or floor-clamped decrements) the
 * given counter field and engagementVersion together, in one SQL
 * statement, no row-lock required (ENGAGEMENT_API_CONTRACT.md §3.3 —
 * SELECT...FOR UPDATE is a confirmed no-op on this project's SQLite
 * dialect; a single UPDATE...WHERE is atomic regardless).
 */
export const incrementCounterAtomic = async (
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
