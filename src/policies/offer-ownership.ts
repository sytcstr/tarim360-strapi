import { denyNoIdentity, loadEntityByRouteId, matchesIdentity, mergeScopeOrFilter, readIdentity } from '../utils/identity';

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

