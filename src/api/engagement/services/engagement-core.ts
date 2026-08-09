/**
 * Shared low-level helpers used by both the membership (like/favorite,
 * engagement-v1.ts) and view (engagement-view-service.ts) service logic.
 * Kept separate so neither file needs to duplicate target resolution or
 * the atomic counter-increment statement.
 */
import { EngagementTargetType, TARGET_UID, VERSION_FIELD } from '../../../utils/engagement-contract';

/**
 * Resolves the target row WITHOUT restricting fields — unlike
 * `utils/identity.ts`'s `loadEntityByRouteId` (which callers use with an
 * explicit, narrow `fields` list for their own known purpose), this
 * function's result is read generically by callers that don't know in
 * advance which counter/version field they'll need (`target[countField]`,
 * `target[VERSION_FIELD]`, `target.updatedAt`). A real boot test (Faz B-V)
 * caught this the hard way: an earlier version restricted `fields` to
 * `['id','documentId']`, which meant every "already in the desired state"
 * no-op response silently reported `count:0`/`serverVersion:0` instead of
 * the real values, because those fields had never been fetched at all.
 *
 * SECOND, MORE SEVERE bug also caught only by real boot-testing: `listing`
 * has `draftAndPublish: true`. `entityService.findOne(uid, id)` resolves
 * the row's `documentId` first, then re-fetches through Strapi's Document
 * Service — which, per `@strapi/core`'s
 * `services/document-service/draft-and-publish.js`, DEFAULTS TO THE DRAFT
 * VERSION unless `status: 'published'` is explicitly requested. Confirmed
 * empirically: creating one listing produces TWO rows (draft id, e.g. 1;
 * published id, e.g. 2, same documentId) — without `status: 'published'`
 * here, every like/favorite/view atomic update was landing on the
 * invisible DRAFT row's counters while the client-facing PUBLISHED
 * listing's counters silently stayed at 0 forever. `status: 'published'`
 * is passed unconditionally below; for content-types without draft/publish
 * enabled this parameter has no special effect (there is only one row).
 */
export const resolveTargetRow = async (
  strapiInstance: any,
  targetType: EngagementTargetType,
  rawTargetId: string,
): Promise<Record<string, any> | null> => {
  const uid = TARGET_UID[targetType];
  const id = String(rawTargetId ?? '').trim();
  if (!id) return null;
  const opts = { status: 'published' as const };

  try {
    const viaEntity = await strapiInstance.entityService.findOne(uid, id, opts);
    if (viaEntity && typeof viaEntity === 'object') return viaEntity;
  } catch (_e) {
    // continue
  }

  const maybeNumeric = Number(id);
  if (Number.isInteger(maybeNumeric) && maybeNumeric > 0) {
    try {
      const viaNumeric = await strapiInstance.entityService.findOne(uid, maybeNumeric, opts);
      if (viaNumeric && typeof viaNumeric === 'object') return viaNumeric;
    } catch (_e) {
      // continue
    }
  }

  try {
    // Prefer the published row if the content-type has draft/publish and
    // both exist for this documentId (same reasoning as above).
    const viaDocumentIdPublished = await strapiInstance.db.query(uid).findOne({
      where: { documentId: id, publishedAt: { $notNull: true } },
    });
    if (viaDocumentIdPublished && typeof viaDocumentIdPublished === 'object') {
      return viaDocumentIdPublished;
    }
    const viaDocumentId = await strapiInstance.db.query(uid).findOne({ where: { documentId: id } });
    if (viaDocumentId && typeof viaDocumentId === 'object') return viaDocumentId;
  } catch (_e) {
    // continue
  }

  return null;
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
