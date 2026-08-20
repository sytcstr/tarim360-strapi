import {
  denyForbidden,
  denyNoIdentity,
  loadEntityByRouteId,
  matchesIdentity,
  normalizeEmail,
  readIdentity,
} from '../utils/identity';

const UID = 'api::hub-content.hub-content';

const normalizeKind = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/[^a-z0-9]+/g, '');

const isFounderOnlyKind = (rawKind: string): boolean => {
  const kind = normalizeKind(rawKind);
  if (!kind) return false;
  if (kind === 'knowledge' || kind.includes('knowledge')) return true;
  if (kind === 'agridata' || kind.includes('agridata')) return true;
  if (kind.includes('bilgi')) return true;
  if (kind.includes('tarimsal') && kind.includes('veri')) return true;
  return false;
};

const parseCsv = (raw: string): string[] =>
  raw
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);

const founderEmails = (() => {
  const raw =
    process.env.HUB_CONTENT_FOUNDER_EMAILS ??
    process.env.FOUNDER_EMAILS ??
    '';
  return new Set(parseCsv(raw).map((x) => normalizeEmail(x)).filter(Boolean));
})();

const founderOwnerIds = (() => {
  const raw =
    process.env.HUB_CONTENT_FOUNDER_OWNER_IDS ??
    process.env.FOUNDER_OWNER_IDS ??
    '';
  return new Set(parseCsv(raw));
})();

const isFounder = (email: string, ownerId: string): boolean => {
  if (founderEmails.has(normalizeEmail(email))) return true;
  if (ownerId && founderOwnerIds.has(ownerId)) return true;
  return false;
};

const allowedReactionFields = new Set<string>([
  'likes',
  'comments',
  'commentCount',
  'commentList',
  'lastCommentText',
  'lastCommentAuthor',
  'lastCommentAt',
  'liked',
  'likedByMe',
]);

const isReactionOnlyUpdate = (data: Record<string, unknown>): boolean => {
  const keys = Object.keys(data);
  if (keys.length === 0) return false;
  return keys.every((k) => allowedReactionFields.has(k));
};

const OWNER_EMAIL_FIELDS = ['ownerEmail'];
const OWNER_PROFILE_FIELDS = ['ownerProfileId'];

/**
 * ENGAGEMENT_E1_TARGETED_FIX_REPORT.md BUG-ENG-001 (CRITICAL): this
 * policy used to restrict ONLY founder-only kinds (Knowledge/AgriData);
 * for every other kind -- ordinary hub posts and, critically,
 * farmerQuestion -- it returned true unconditionally with no per-row
 * ownership check at all, letting any authenticated user overwrite or
 * delete any other user's post.
 *
 * Two real, live constraints shaped the fix:
 * 1. hub-content had NO identity field at all before this fix (only a
 *    cosmetic authorName string) -- ownerEmail/ownerProfileId were added
 *    to the schema and are now stamped server-side on create (see
 *    hub-content.ts), never trusted from client-supplied ownerId/
 *    ownerEmail/profileId/email/author-style fields.
 * 2. Farmer-question "answering" is a REAL, live, core cross-user
 *    feature implemented as a full-row PUT (farmer_questions_repo.dart's
 *    addAnswer resends the entire question payload, including the
 *    original asker's title/descShort, with the new answer appended
 *    inside the JSON `body` blob) -- a strict "only the owner may PUT"
 *    rule would silently break answering. Non-owner PUT/PATCH is
 *    therefore allowed when it does not change the row's own title/
 *    descShort (the question's/post's user-visible identity) relative
 *    to what's currently stored -- exactly what a legitimate answer-add
 *    looks like, and exactly what a defacement attempt would need to
 *    change to have any visible effect. This does not (and is not
 *    intended to) protect the embedded commentList/answers JSON from a
 *    forged-authorship/lost-update race -- that is the separate,
 *    already-disclosed, deliberately-deferred BUG-ENG-014.
 * DELETE has no such carve-out anywhere -- there is no legitimate
 * cross-user reason to delete someone else's post/question, founder-only
 * kind or not.
 */
const isUnchangedCoreIdentity = (
  data: Record<string, unknown>,
  entity: Record<string, unknown>,
): boolean => {
  for (const field of ['title', 'descShort']) {
    if (!Object.prototype.hasOwnProperty.call(data, field)) continue;
    if (String(data[field] ?? '') !== String(entity[field] ?? '')) return false;
  }
  return true;
};

export default async (ctx: any, _config: unknown, { strapi }: any) => {
  const method = String(ctx.request?.method ?? '').toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return true;

  const identity = readIdentity(ctx);
  if (!identity) return denyNoIdentity(ctx);

  const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
  const data = ((body.data ?? {}) as Record<string, unknown>) ?? {};

  if (method === 'POST') {
    // No existing row to check ownership against yet -- only the
    // client's own creation intent can supply a kind here. Server-side
    // identity stamping (hub-content.ts) makes the created row's real
    // owner authoritative from this point on.
    const targetKind = String(data.kind ?? '').trim();
    if (isFounderOnlyKind(targetKind) && !isFounder(identity.email, identity.ownerId)) {
      return denyForbidden(
        ctx,
        'Bilgi Bankasi ve Tarimsal Veriler iceriklerini sadece kurucu hesaplar yonetebilir.',
      );
    }
    return true;
  }

  // PUT/PATCH/DELETE: resolve the REAL row -- never trust a client-
  // supplied `kind` for authorization once a row already exists (a
  // caller could otherwise lie about kind to dodge either check below).
  const id = String(ctx.params?.id ?? '').trim();
  const entity = id
    ? await loadEntityByRouteId(strapi, UID, id, [
        'kind',
        'ownerEmail',
        'ownerProfileId',
        'title',
        'descShort',
      ])
    : null;
  if (!entity) {
    return denyForbidden(ctx, 'Icerik bulunamadi veya erisim yetkiniz yok.');
  }
  const targetKind = String(entity.kind ?? '').trim();

  if (isFounderOnlyKind(targetKind)) {
    if (isFounder(identity.email, identity.ownerId)) return true;
    if ((method === 'PUT' || method === 'PATCH') && isReactionOnlyUpdate(data)) {
      return true;
    }
    return denyForbidden(
      ctx,
      'Bilgi Bankasi ve Tarimsal Veriler iceriklerini sadece kurucu hesaplar yonetebilir.',
    );
  }

  const isOwner = matchesIdentity(entity, identity, OWNER_EMAIL_FIELDS, OWNER_PROFILE_FIELDS);
  if (isOwner) return true;

  if (method === 'DELETE') {
    return denyForbidden(ctx, 'Bu icerigi yalnizca olusturan kullanici silebilir.');
  }

  // PUT/PATCH by a non-owner: allowed only as a reaction-only update
  // (likes/comments/commentList/etc.) or as an update that leaves the
  // row's own title/descShort unchanged (the legitimate "answer/react
  // without altering the original post" shape).
  if (isReactionOnlyUpdate(data) || isUnchangedCoreIdentity(data, entity)) {
    return true;
  }

  return denyForbidden(
    ctx,
    'Bu icerigi yalnizca olusturan kullanici guncelleyebilir.',
  );
};
