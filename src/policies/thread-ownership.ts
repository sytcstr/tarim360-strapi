import {
  denyForbidden,
  denyNoIdentity,
  loadEntityByRouteId,
  matchesIdentity,
  mergeScopeOrFilter,
  normalizeEmail,
  ownerIdFromEmail,
  readIdentity,
  resolveListingContextByAnyId,
} from '../utils/identity';

const UID = 'api::thread.thread';
const EMAIL_FIELDS = ['requesterEmail', 'receiverEmail', 'lastSenderEmail'];
const PROFILE_FIELDS = ['requesterProfileId', 'receiverProfileId', 'lastSenderProfileId'];

export default async (ctx: any, _config: unknown, { strapi }: any) => {
  const identity = readIdentity(ctx);
  if (!identity) return denyNoIdentity(ctx);

  const method = String(ctx.request?.method ?? '').toUpperCase();
  const id = String(ctx.params?.id ?? '').trim();

  if (method === 'GET' && !id) {
    mergeScopeOrFilter(ctx, [
      { requesterEmail: { $eq: identity.email } },
      { receiverEmail: { $eq: identity.email } },
      { requesterProfileId: { $eq: identity.ownerId } },
      { receiverProfileId: { $eq: identity.ownerId } },
    ]);
    return true;
  }

  if (method === 'POST') {
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const data = (body.data ?? {}) as Record<string, unknown>;

    let receiverEmail = normalizeEmail(data.receiverEmail);
    let receiverProfileId = String(data.receiverProfileId ?? '').trim();

    // LISTING_AZ_REVALIDATION_PART5_81_100.md Madde 92 (P1): requesterEmail/
    // requesterProfileId used to be taken from the client first and only
    // defaulted to the caller's own identity when both were empty -- so an
    // attacker could name themselves as `receiver` (trivially satisfying
    // the "participant set contains me" check below) while claiming an
    // arbitrary real user's email as `requesterEmail`, injecting a
    // fabricated thread into that stranger's own inbox (live PoC
    // confirmed: POST here with a victim's email as requesterEmail creates
    // a thread that shows up in the victim's own `/conversations/mine`).
    // The requester of a brand-new thread is always whoever is actually
    // creating it -- the exact same invariant message-ownership.ts's POST
    // branch and conversation.ts's applyVerifiedRequester already enforce
    // -- so it is now forced unconditionally from server-verified
    // identity, never read from the client.
    const requesterEmail = identity.email;
    const requesterProfileId = identity.ownerId;

    // LISTING_AZ_REVALIDATION_PART2_21_40.md Madde 26 (P0): this stock-
    // CRUD create route sits on the same `thread` content type as
    // conversation.ts's own `/conversations/upsert`, whose
    // `verifyAndCorrectReceiver` already rejects creating a brand-new
    // thread about a pending/rejected listing -- this route had no
    // equivalent check. This is a plain create (no find-or-merge-into-an-
    // existing-thread logic on this stock path), so the check applies
    // unconditionally whenever the referenced id resolves to a real
    // listing row, regardless of whether the client also supplied a
    // receiver directly.
    const listingLikeId = data.listingId ?? data.listingNo;
    const owner =
      listingLikeId != null
        ? await resolveListingContextByAnyId(strapi, listingLikeId)
        : null;
    // Rejected via denyForbidden (403) rather than a 400 -- Strapi's
    // policy contract makes a genuine 400 unreachable from a policy (see
    // message-ownership.ts's identical check for the full explanation).
    if (owner && owner.status && owner.status !== 'active') {
      return denyForbidden(
        ctx,
        'Bu ilan artik aktif degil, yeni sohbet baslatilamaz.',
      );
    }

    if (!receiverEmail || !receiverProfileId) {
      if (!receiverEmail && owner?.email && owner.email !== identity.email) {
        receiverEmail = owner.email;
      }
      if (
        !receiverProfileId &&
        owner?.ownerId &&
        owner.ownerId !== identity.ownerId
      ) {
        receiverProfileId = owner.ownerId;
      }
    }

    if (!receiverProfileId && receiverEmail) {
      receiverProfileId = ownerIdFromEmail(receiverEmail);
    }

    if (!receiverEmail && !receiverProfileId) {
      ctx.forbidden('Sohbet alicisi bulunamadi.');
      return false;
    }

    // requesterEmail/requesterProfileId are now always identity.email/
    // identity.ownerId (see above), so this "participant set contains me"
    // check can no longer be defeated by a spoofed requester -- it is kept
    // as a defense-in-depth guard against a still-malformed receiver claim
    // (e.g. one that resolves to neither party), matching the same
    // redundant-by-design pattern used elsewhere (e.g. offer-ownership.ts).
    const emailContainsMe = requesterEmail === identity.email || receiverEmail === identity.email;
    const profileContainsMe =
      requesterProfileId === identity.ownerId || receiverProfileId === identity.ownerId;

    if (!(emailContainsMe || profileContainsMe)) {
      ctx.forbidden('Sohbet katilimci bilgileri aktif oturumla uyusmuyor.');
      return false;
    }

    data.requesterEmail = requesterEmail;
    data.requesterProfileId = requesterProfileId;
    data.receiverEmail = receiverEmail;
    data.receiverProfileId = receiverProfileId;
    body.data = data;
    ctx.request.body = body;
    return true;
  }

  if (id) {
    const entity = await loadEntityByRouteId(strapi, UID, id, [...EMAIL_FIELDS, ...PROFILE_FIELDS]);
    const allowed = matchesIdentity(entity, identity, EMAIL_FIELDS, PROFILE_FIELDS);
    if (!allowed) {
      ctx.forbidden('Bu sohbet kaydina erisim yetkin yok.');
      return false;
    }
  }

  return true;
};
