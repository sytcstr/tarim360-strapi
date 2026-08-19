import { denyForbidden, denyNoIdentity, loadEntityByRouteId, normalizeEmail, ownerIdFromEmail, readIdentity } from '../utils/identity';

const UID = 'api::listing.listing';

export default async (ctx: any, _config: unknown, { strapi }: any) => {
  const method = String(ctx.request?.method ?? '').toUpperCase();

  // Public reads stay open.
  if (method === 'GET') return true;

  const identity = readIdentity(ctx);
  if (!identity) return denyNoIdentity(ctx);

  const id = String(ctx.params?.id ?? '').trim();
  if (method === 'POST') {
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const data = (body.data ?? {}) as Record<string, unknown>;
    data.ownerEmail = identity.email;
    data.ownerProfileId = identity.ownerId;
    data.ownerId = identity.ownerId;
    body.data = data;
    ctx.request.body = body;
    return true;
  }

  if (!id) {
    ctx.badRequest('Kayit kimligi zorunlu.');
    return false;
  }

  const entity = await loadEntityByRouteId(strapi, UID, id, ['ownerEmail', 'ownerProfileId', 'ownerId']);
  if (!entity) {
    return denyForbidden(ctx, 'Bu ilana erisim yetkin yok.');
  }

  const ownerEmail = normalizeEmail(entity.ownerEmail);
  const ownerProfileId = String(entity.ownerProfileId ?? '').trim();
  const ownerId = String(entity.ownerId ?? '').trim();
  const resolvedOwnerId = ownerProfileId || ownerId || ownerIdFromEmail(ownerEmail);

  if (ownerEmail !== identity.email && resolvedOwnerId !== identity.ownerId) {
    return denyForbidden(ctx, 'Bu ilana erisim yetkin yok.');
  }

  return true;
};

