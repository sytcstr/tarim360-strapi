import { denyNoIdentity, loadEntityByRouteId, normalizeEmail, readIdentity } from '../utils/identity';

const UID = 'api::ad.ad';

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
    data.requestedByEmail = identity.email;
    data.requestedByProfileId = identity.ownerId;
    if (String(data.ownerProfileId ?? '').trim().length == 0) {
      data.ownerProfileId = identity.ownerId;
    }
    if (String(data.submitter ?? '').trim().length == 0) {
      data.submitter = identity.email;
    }
    body.data = data;
    ctx.request.body = body;
    return true;
  }

  if (!id) {
    ctx.badRequest('Kayit kimligi zorunlu.');
    return false;
  }

  const entity = await loadEntityByRouteId(strapi, UID, id, [
    'requestedByEmail',
    'requestedByProfileId',
    'ownerProfileId',
    'submitter',
  ]);
  if (!entity) {
    ctx.forbidden('Bu reklama erisim yetkin yok.');
    return false;
  }

  const requestedByEmail = normalizeEmail(entity.requestedByEmail);
  const submitter = normalizeEmail(entity.submitter);
  const requestedByProfileId = String(entity.requestedByProfileId ?? '').trim();
  const ownerProfileId = String(entity.ownerProfileId ?? '').trim();
  const mine =
    requestedByEmail === identity.email ||
    submitter === identity.email ||
    requestedByProfileId === identity.ownerId ||
    ownerProfileId === identity.ownerId;

  if (!mine) {
    ctx.forbidden('Bu reklama erisim yetkin yok.');
    return false;
  }

  return true;
};

