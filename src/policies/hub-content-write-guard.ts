import {
  denyForbidden,
  denyNoIdentity,
  isFarmerQuestionCommentKind,
  isFarmerQuestionKind,
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

// `engagementVersion` belongs here alongside `likes`: the controller's
// own stripEngagementFields() already unconditionally deletes both
// before any update ever reaches the DB (see hub-content.ts), so
// treating a payload that only touches these two as "reaction-only" at
// the policy level is just as safe -- they can never actually change
// anything regardless of what this check decides.
const allowedReactionFields = new Set<string>([
  'likes',
  'engagementVersion',
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

/**
 * "Çiftçiden Sorular" audit follow-up (kalan sınır: soru sahibi de
 * başkasının gömülü cevabını değiştirebiliyor/çoğaltabiliyor/yenisini
 * ekleyebiliyor muydu?): the non-owner path above now fully blocks a
 * `body` change for farmerQuestion-family rows, but the OWNER path
 * (`if (isOwner) return true;`) historically had NO restriction at all
 * -- and farmer_questions_repo.dart's own background cleanup
 * (`_cleanupInactiveContentInBackground`) legitimately DOES resend the
 * owner's full `_toQuestionPayload(q)` (title/descShort/body, with
 * `body.answers` rebuilt from the client's current in-memory answer
 * list) whenever an answerer's account goes inactive, to drop that
 * answer. A compromised/modified owner client could abuse that exact
 * same legitimate call shape to (a) rewrite an EXISTING answer's own
 * name/profileId/email/text, (b) duplicate an existing answerId's
 * identity onto a different entry, or (c) inject a brand-new, entirely
 * fake answer with any authorship it likes -- the owner's write access
 * was never meant to extend to any of those; the ONLY legitimate thing
 * this path may still do to `answers` is REMOVE entries.
 *
 * This parses both the stored and incoming `body` JSON's `answers`
 * array (keyed by each answer's own `answerId`) and requires:
 *   1. the incoming set of answerIds is a SUBSET of the stored set --
 *      no new answerId may appear here at all (the dedicated endpoint,
 *      never this one, is the only path that may create a new answer
 *      row with someone else's authorship: the caller's own), and
 *   2. every answerId present in both is byte-identical on its
 *      identity-bearing fields (name/profileId/email/text) -- no
 *      rewriting, and no duplicating one real answer's identity onto
 *      another entry (that would also change the OTHER entry's own
 *      recorded fields away from whatever was stored for it, or
 *      introduce a new id -- either way caught by these two rules).
 * Removing an answer (the real cleanup use case) is unaffected -- it
 * simply won't be in the new map.
 */
const ANSWER_IDENTITY_FIELDS = ['name', 'profileId', 'email', 'text'];

const parseEmbeddedAnswersById = (rawBody: unknown): Map<string, Record<string, unknown>> => {
  const map = new Map<string, Record<string, unknown>>();
  try {
    const parsed = JSON.parse(String(rawBody ?? ''));
    const answers = Array.isArray(parsed?.answers) ? parsed.answers : [];
    for (const answer of answers) {
      if (!answer || typeof answer !== 'object') continue;
      const id = String((answer as Record<string, unknown>).answerId ?? '').trim();
      if (id) map.set(id, answer as Record<string, unknown>);
    }
  } catch (_e) {
    // Unparseable body -- nothing to protect against here specifically;
    // the caller treats an empty map as "no prior answers recorded".
  }
  return map;
};

const embeddedAnswersAuthorshipUnchanged = (
  storedBodyRaw: unknown,
  incomingBodyRaw: unknown,
): boolean => {
  const stored = parseEmbeddedAnswersById(storedBodyRaw);
  const incoming = parseEmbeddedAnswersById(incomingBodyRaw);
  for (const [id, incomingAnswer] of incoming) {
    const storedAnswer = stored.get(id);
    if (!storedAnswer) {
      // A new answerId that was never stored before -- this path may
      // only ever REMOVE answers, never add one.
      return false;
    }
    for (const field of ANSWER_IDENTITY_FIELDS) {
      if (String(incomingAnswer[field] ?? '') !== String(storedAnswer[field] ?? '')) {
        return false;
      }
    }
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
        'body',
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
  if (isOwner) {
    if (
      (method === 'PUT' || method === 'PATCH') &&
      (isFarmerQuestionKind(targetKind) || isFarmerQuestionCommentKind(targetKind)) &&
      Object.prototype.hasOwnProperty.call(data, 'body') &&
      !embeddedAnswersAuthorshipUnchanged(entity.body, data.body)
    ) {
      return denyForbidden(
        ctx,
        'Mevcut cevaplarin yazar bilgisi degistirilemez.',
      );
    }
    return true;
  }

  if (method === 'DELETE') {
    return denyForbidden(ctx, 'Bu icerigi yalnizca olusturan kullanici silebilir.');
  }

  // "Çiftçiden Sorular" audit follow-up: the "unchanged title/descShort"
  // escape hatch below exists ONLY because answering a question used to
  // be a non-owner full-row PUT (see this file's own BUG-ENG-001 comment
  // above). That flow has been replaced by a dedicated, server-verified
  // endpoint (POST /hub-contents/farmer-questions/:questionId/answers,
  // hub-content.ts's addFarmerQuestionAnswer) that never goes through
  // this PUT/PATCH path at all. Leaving the escape hatch open for
  // farmerQuestion/farmerQuestionComment rows would let a non-owner keep
  // forging the `body` JSON (which carries each embedded answer's own
  // name/profileId/email) through the OLD generic route, as long as
  // title/descShort are left alone -- exactly the "lost-update race /
  // forged authorship" class of bug the new endpoint exists to close.
  // Nothing legitimate needs a non-owner body-PUT on these kinds any
  // more, so only a strict reaction-only update (likes/comments
  // metadata) is allowed here now; every other kind keeps its prior
  // behavior unchanged.
  const isFarmerQuestionFamily =
    isFarmerQuestionKind(targetKind) || isFarmerQuestionCommentKind(targetKind);

  // PUT/PATCH by a non-owner: allowed only as a reaction-only update
  // (likes/comments/commentList/etc.) or -- for every kind EXCEPT the
  // farmer-question family -- as an update that leaves the row's own
  // title/descShort unchanged (the legitimate "answer/react without
  // altering the original post" shape still used by, e.g., the
  // Knowledge Hub's own comment system).
  if (
    isReactionOnlyUpdate(data) ||
    (!isFarmerQuestionFamily && isUnchangedCoreIdentity(data, entity))
  ) {
    return true;
  }

  return denyForbidden(
    ctx,
    'Bu icerigi yalnizca olusturan kullanici guncelleyebilir.',
  );
};
