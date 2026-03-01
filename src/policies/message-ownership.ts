import {
  denyNoIdentity,
  loadEntityByRouteId,
  matchesIdentity,
  mergeScopeOrFilter,
  normalizeEmail,
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
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const data = (body.data ?? {}) as Record<string, unknown>;

    const threadId = String(data.threadId ?? '').trim();
    let requesterEmail = normalizeEmail(data.requesterEmail);
    let receiverEmail = normalizeEmail(data.receiverEmail);
    let requesterProfileId = String(data.requesterProfileId ?? '').trim();
    let receiverProfileId = String(data.receiverProfileId ?? '').trim();

    if (threadId) {
      const fromThread = await resolveThreadParticipantsByThreadId(
        strapi,
        threadId,
      );
      if (fromThread) {
        if (!requesterEmail && fromThread.requesterEmail) {
          requesterEmail = fromThread.requesterEmail;
        }
        if (!requesterProfileId && fromThread.requesterProfileId) {
          requesterProfileId = fromThread.requesterProfileId;
        }
        if (!receiverEmail && fromThread.receiverEmail) {
          receiverEmail = fromThread.receiverEmail;
        }
        if (!receiverProfileId && fromThread.receiverProfileId) {
          receiverProfileId = fromThread.receiverProfileId;
        }
      }
    }

    if (!requesterEmail) requesterEmail = identity.email;
    if (!requesterProfileId) requesterProfileId = identity.ownerId;

    if (!receiverEmail || !receiverProfileId) {
      const owner = await resolveListingOwnerByAnyId(
        strapi,
        data.listingId ?? data.listingNo,
      );
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
    if (!requesterProfileId && requesterEmail) {
      requesterProfileId = ownerIdFromEmail(requesterEmail);
    }

    const emailParticipantSet = requesterEmail || receiverEmail;
    const profileParticipantSet = requesterProfileId || receiverProfileId;
    const emailContainsMe = requesterEmail === identity.email || receiverEmail === identity.email;
    const profileContainsMe =
      requesterProfileId === identity.ownerId || receiverProfileId === identity.ownerId;

    if (!receiverEmail && !receiverProfileId) {
      ctx.forbidden('Mesaj alicisi bulunamadi.');
      return false;
    }

    if ((emailParticipantSet || profileParticipantSet) && !(emailContainsMe || profileContainsMe)) {
      ctx.forbidden('Mesaj katilimci bilgileri aktif oturumla uyusmuyor.');
      return false;
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
      ctx.forbidden('Bu mesaj kaydina erisim yetkin yok.');
      return false;
    }
  }

  return true;
};
