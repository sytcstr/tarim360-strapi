import {
  denyNoIdentity,
  loadEntityByRouteId,
  matchesIdentity,
  mergeScopeOrFilter,
  readIdentity,
} from '../utils/identity';

const UID = 'api::support-ticket.support-ticket';
const EMAIL_FIELDS = ['ownerEmail'];
const PROFILE_FIELDS = ['ownerProfileId'];

export default async (ctx: any, _config: unknown, { strapi }: any) => {
  const identity = readIdentity(ctx);
  if (!identity) return denyNoIdentity(ctx);

  const method = String(ctx.request?.method ?? '').toUpperCase();
  const id = String(ctx.params?.id ?? '').trim();

  if (method === 'GET' && !id) {
    mergeScopeOrFilter(ctx, [
      { ownerEmail: { $eq: identity.email } },
      { ownerProfileId: { $eq: identity.ownerId } },
    ]);
    return true;
  }

  if (method === 'POST') {
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const data = (body.data ?? {}) as Record<string, unknown>;

    const ownerEmail = String(data.ownerEmail ?? '').trim().toLowerCase();
    const ownerProfileId = String(data.ownerProfileId ?? '').trim();
    if (ownerEmail && ownerEmail !== identity.email) {
      ctx.forbidden('Baska kullanici adina destek talebi acamazsiniz.');
      return false;
    }
    if (ownerProfileId && ownerProfileId !== identity.ownerId) {
      ctx.forbidden('Destek talebi profil bilgisi aktif oturumla uyusmuyor.');
      return false;
    }

    data.ownerEmail = identity.email;
    data.ownerProfileId = identity.ownerId;
    if (!String(data.status ?? '').trim()) {
      data.status = 'open';
    }
    body.data = data;
    ctx.request.body = body;
    return true;
  }

  if (id) {
    const entity = await loadEntityByRouteId(strapi, UID, id, [
      ...EMAIL_FIELDS,
      ...PROFILE_FIELDS,
    ]);
    const allowed = matchesIdentity(
      entity,
      identity,
      EMAIL_FIELDS,
      PROFILE_FIELDS,
    );
    if (!allowed) {
      ctx.forbidden('Bu destek talebine erisim yetkin yok.');
      return false;
    }
  }

  return true;
};
