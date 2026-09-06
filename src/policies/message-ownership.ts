import {
  denyForbidden,
  denyNoIdentity,
  loadEntityByRouteId,
  matchesIdentity,
  mergeScopeOrFilter,
  ownerIdFromEmail,
  readIdentity,
  resolveListingContextByAnyId,
  resolveThreadParticipantsByThreadId,
} from '../utils/identity';

const UID = 'api::message.message';
const EMAIL_FIELDS = ['senderEmail', 'requesterEmail', 'receiverEmail'];
const PROFILE_FIELDS = ['senderProfileId', 'requesterProfileId', 'receiverProfileId'];

export default async (ctx: any, _config: unknown, { strapi }: any) => {
  const identity = readIdentity(ctx);
  if (!identity) return denyNoIdentity(ctx);

  const method = String(ctx.request?.method ?? '').toUpperCase();
  const id = String(ctx.params?.id ?? '').trim();

  if (method === 'GET' && !id) {
    mergeScopeOrFilter(ctx, [
      { senderEmail: { $eq: identity.email } },
      { requesterEmail: { $eq: identity.email } },
      { receiverEmail: { $eq: identity.email } },
      { senderProfileId: { $eq: identity.ownerId } },
      { requesterProfileId: { $eq: identity.ownerId } },
      { receiverProfileId: { $eq: identity.ownerId } },
    ]);
    return true;
  }

  if (method === 'POST') {
    // NOTIFICATION_N1_SECURITY_FIX_REPORT.md BUG-NOTIF-002: receiverEmail/
    // receiverProfileId used to be taken from the client first and only
    // DB-resolved as a fallback for whichever half was left empty -- and
    // since requesterEmail always defaults to the caller's own identity,
    // the old "participant contains me" check downstream was trivially
    // satisfied regardless of what receiver the client claimed. The
    // receiver is now ALWAYS the server-resolved thread participant (when
    // threadId resolves to a real, existing thread the caller is actually
    // part of) or the server-resolved listing owner (when no thread
    // exists yet but the message references a real listing whose owner
    // isn't the caller themselves) -- never the client-supplied value.
    // If neither resolves, the receiver cannot be safely verified and the
    // request is rejected rather than trusting an unverifiable client
    // claim.
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const data = (body.data ?? {}) as Record<string, unknown>;

    const threadId = String(data.threadId ?? '').trim();
    const requesterEmail = identity.email;
    const requesterProfileId = identity.ownerId;
    let receiverEmail = '';
    let receiverProfileId = '';
    let receiverVerified = false;
    let existingThreadFound = false;

    if (threadId) {
      const fromThread = await resolveThreadParticipantsByThreadId(
        strapi,
        threadId,
      );
      if (fromThread) {
        existingThreadFound = true;
        const callerIsRequester =
          fromThread.requesterEmail === identity.email ||
          fromThread.requesterProfileId === identity.ownerId;
        const callerIsReceiver =
          fromThread.receiverEmail === identity.email ||
          fromThread.receiverProfileId === identity.ownerId;
        if (!callerIsRequester && !callerIsReceiver) {
          return denyForbidden(ctx, 'Bu konusmaya katilimci degilsiniz.');
        }
        receiverEmail = callerIsRequester
          ? fromThread.receiverEmail
          : fromThread.requesterEmail;
        receiverProfileId = callerIsRequester
          ? fromThread.receiverProfileId
          : fromThread.requesterProfileId;
        receiverVerified = true;
      }
    }

    if (!receiverVerified) {
      const owner = await resolveListingContextByAnyId(
        strapi,
        data.listingId ?? data.listingNo,
      );
      // LISTING_AZ_REVALIDATION_PART2_21_40.md Madde 26 (P0): this stock-
      // CRUD create route sits on the exact same `message` content type
      // as conversation.ts's own `/conversations/message` endpoint, whose
      // `verifyAndCorrectReceiver` already rejects (400) a brand-new
      // message referencing a pending/rejected listing -- this route had
      // no equivalent check at all, letting a caller bypass that
      // lifecycle rule entirely by posting here directly instead. Only
      // applies when no existing thread already covers this conversation
      // (mirrors conversation.ts: an existing thread must never be
      // retroactively broken by its listing later going inactive).
      // Rejected via denyForbidden (403), not a 400, because Strapi's
      // policy contract makes a genuine 400 unreachable from a policy:
      // confirmed live (@strapi/core's createPolicicesMiddleware) that
      // any non-true/undefined policy return is unconditionally replaced
      // with a blank, generic 403 PolicyError -- whatever status/message
      // the policy tried to set is discarded regardless (the policy also
      // only ever receives a shallow Object.assign COPY of ctx, so
      // ctx.throw/.badRequest calls inside a policy never reach the real
      // response either way). 403 here is what this route's every other
      // rejection already produces (e.g. "Mesaj alicisi dogrulanamadi"
      // below) -- consistent with the rest of this policy, not a
      // regression from the custom endpoint's 400.
      if (
        !existingThreadFound &&
        owner &&
        owner.status &&
        owner.status !== 'active'
      ) {
        return denyForbidden(
          ctx,
          'Bu ilan artik aktif degil, yeni mesaj gonderilemez.',
        );
      }
      if (
        owner &&
        owner.email !== identity.email &&
        owner.ownerId !== identity.ownerId &&
        (owner.email || owner.ownerId)
      ) {
        receiverEmail = owner.email;
        receiverProfileId = owner.ownerId;
        receiverVerified = true;
      }
    }

    if (!receiverVerified) {
      return denyForbidden(ctx, 'Mesaj alicisi dogrulanamadi.');
    }
    if (!receiverProfileId && receiverEmail) {
      receiverProfileId = ownerIdFromEmail(receiverEmail);
    }

    data.requesterEmail = requesterEmail;
    data.requesterProfileId = requesterProfileId;
    data.receiverEmail = receiverEmail;
    data.receiverProfileId = receiverProfileId;
    data.senderEmail = identity.email;
    data.senderProfileId = identity.ownerId;
    body.data = data;
    ctx.request.body = body;
    return true;
  }

  if (id) {
    const entity = await loadEntityByRouteId(strapi, UID, id, [...EMAIL_FIELDS, ...PROFILE_FIELDS]);
    const allowed = matchesIdentity(entity, identity, EMAIL_FIELDS, PROFILE_FIELDS);
    if (!allowed) {
      return denyForbidden(ctx, 'Bu mesaj kaydina erisim yetkin yok.');
    }
  }

  return true;
};
