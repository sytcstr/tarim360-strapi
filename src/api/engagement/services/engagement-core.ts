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
/**
 * The Flutter app identifies a listing as `strapi_<numeric id>` (its
 * ProfileProduct.id) and sends that string verbatim as the engagement
 * targetId. The engagement resolver only understood a bare numeric id or a
 * documentId, so in production every favorite/like/view from the app
 * answered 404 "listing bulunamadi: strapi_64". Strip exactly one leading
 * `strapi_`/`listing_` app prefix and nothing else -- deliberately NOT
 * "extract the digits", which would let an arbitrary string resolve to the
 * wrong listing.
 */
export const stripListingIdPrefix = (
  targetType: EngagementTargetType,
  id: string,
): string => {
  if (targetType !== 'listing') return id;
  for (const prefix of ['strapi_', 'listing_']) {
    if (id.startsWith(prefix)) {
      const rest = id.slice(prefix.length).trim();
      if (rest) return rest;
    }
  }
  return id;
};

/**
 * Stable storage key for a per-actor engagement record. A listing's numeric
 * id is NOT stable: every publish (each owner edit) replaces the published
 * row with a new one, so a key built from `target.id` orphaned every
 * favorite/like/view on the listing's first edit. `documentId` survives.
 * `legacy` is the old numeric key, still read so rows written before this
 * change keep working.
 */
export const engagementRecordKeys = (
  target: Record<string, any>,
  targetType?: EngagementTargetType,
): { key: string; legacy: string; both: string[] } => {
  const legacy = String(target.id);
  // Only listings are re-published under a new numeric id on every edit;
  // every other target type keeps its numeric key (rows already stored so).
  const doc = targetType === 'listing' ? String(target.documentId ?? '').trim() : '';
  const key = doc || legacy;
  return { key, legacy, both: key === legacy ? [key] : [key, legacy] };
};

export const resolveTargetRow = async (
  strapiInstance: any,
  targetType: EngagementTargetType,
  rawTargetId: string,
): Promise<Record<string, any> | null> => {
  const uid = TARGET_UID[targetType];
  const id = stripListingIdPrefix(targetType, String(rawTargetId ?? '').trim());
  if (!id) return null;
  const opts = { status: 'published' as const };

  // entityService.findOne(uid, id) is a `WHERE id = <id>` lookup on the
  // INTEGER primary key. Handing it a documentId string is harmless on
  // SQLite (loose typing just yields no row) but on Postgres -- the
  // Strapi Cloud production dialect -- it raises `invalid input syntax
  // for type integer`. Both callers (setMembership, recordView) run this
  // function INSIDE a db.transaction, and a failed statement aborts a
  // Postgres transaction: every later query in it (including the
  // documentId fallback below) then fails too, this function returned
  // null, and PUT /engagements/favorite|like|view and the legacy toggle
  // routes answered 404 for any documentId target while numeric ids
  // worked. The local SQLite integration suite could never see this.
  // Only ever pass entityService a real integer id.
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
  documentId?: string | null,
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
          // CASE, not MAX(a, b): the two-argument scalar MAX() only exists
          // in SQLite. Postgres (Strapi Cloud production) has no such
          // function (it needs GREATEST(), which SQLite lacks), so the old
          // `MAX(?? - 1, 0)` made EVERY decrement -- every unfavorite,
          // unlike -- fail with a 500 on production while passing every
          // local SQLite test. CASE WHEN is portable across all dialects.
          [countCol]: trx.raw(`CASE WHEN ?? > 0 THEN ?? - 1 ELSE 0 END`, [countCol, countCol]),
          [versionCol]: trx.raw(`?? + 1`, [versionCol]),
        };
  await trx(collectionName).where('id', id).update(setClause);
  const row = await trx(collectionName).where('id', id).first(countCol, versionCol, 'updated_at');
  const count = Number(row?.[countCol] ?? 0);
  const serverVersion = Number(row?.[versionCol] ?? 0);
  // Draft & Publish types keep TWO rows per documentId, and Strapi rebuilds
  // the published row FROM THE DRAFT on every publish (each owner edit).
  // Counters written only to the published row were therefore wiped back to
  // the draft's creation-time zeros on the listing's first edit (measured in
  // production: favorite 1 -> 0, like 1 -> 0, view 1 -> 0). Mirror the new
  // values onto every sibling row so the draft is never behind. A no-op for
  // content types without Draft & Publish (no sibling rows exist).
  if (documentId) {
    await trx(collectionName)
      .where('document_id', documentId)
      .whereNot('id', id)
      .update({ [countCol]: count, [versionCol]: serverVersion });
  }
  return {
    count,
    serverVersion,
    updatedAt: row?.updated_at ?? new Date().toISOString(),
  };
};
