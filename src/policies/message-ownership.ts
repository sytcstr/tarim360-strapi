import {
  denyForbidden,
  denyNoIdentity,
  loadEntityByRouteId,
  matchesIdentity,
  mergeScopeOrFilter,
  ownerIdFromEmail,
  readIdentity,
  resolveListingOwnerByAnyId,
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

    if (threadId) {
      const fromThread = await resolveThreadParticipantsByThreadId(
        strapi,
        threadId,
      );
      if (fromThread) {
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
      const owner = await resolveListingOwnerByAnyId(
        strapi,
        data.listingId ?? data.listingNo,
      );
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
