import {
  denyNoIdentity,
  loadEntityByRouteId,
  matchesIdentity,
  mergeScopeOrFilter,
  ownerIdFromEmail,
  readIdentity,
  resolveListingOwnerByAnyId,
} from '../utils/identity';

const UID = 'api::offer.offer';
const EMAIL_FIELDS = ['requesterEmail', 'receiverEmail'];
const PROFILE_FIELDS = ['requesterProfileId', 'receiverProfileId'];

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

    const requesterEmail = String(data.requesterEmail ?? '').trim().toLowerCase();
    const requesterProfileId = String(data.requesterProfileId ?? '').trim();
    if (requesterEmail && requesterEmail !== identity.email) {
      ctx.forbidden('Teklif acan kullanici eslesmiyor.');
      return false;
    }
    if (requesterProfileId && requesterProfileId !== identity.ownerId) {
      ctx.forbidden('Teklif profil kimligi eslesmiyor.');
      return false;
    }

    data.requesterEmail = identity.email;
    data.requesterProfileId = identity.ownerId;

    let receiverEmail = String(data.receiverEmail ?? '').trim().toLowerCase();
    let receiverProfileId = String(data.receiverProfileId ?? '').trim();

    if (!receiverEmail || !receiverProfileId) {
      const owner = await resolveListingOwnerByAnyId(
        strapi,
        data.listingId ?? data.listingNo,
      );
      if (!receiverEmail && owner?.email) receiverEmail = owner.email;
      if (!receiverProfileId && owner?.ownerId) {
        receiverProfileId = owner.ownerId;
      }
    }

    if (!receiverProfileId && receiverEmail) {
      receiverProfileId = ownerIdFromEmail(receiverEmail);
    }

    if (!receiverEmail && !receiverProfileId) {
      ctx.forbidden('Teklif alicisi bulunamadi. Ilan sahibi bilgisi eksik.');
      return false;
    }

    if (
      receiverEmail === identity.email ||
      receiverProfileId === identity.ownerId
    ) {
      ctx.forbidden('Kendi ilaniniza teklif veremezsiniz.');
      return false;
    }

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
      ctx.forbidden('Bu teklif kaydina erisim yetkin yok.');
      return false;
    }
  }

  return true;
};
