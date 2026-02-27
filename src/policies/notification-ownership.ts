import { denyNoIdentity, loadEntityByRouteId, mergeScopeOrFilter, normalizeEmail, readIdentity } from '../utils/identity';

const UID = 'api::notification.notification';

const isMine = (entity: Record<string, unknown>, email: string, ownerId: string) => {
  const targetEmail = normalizeEmail(entity.targetEmail);
  const targetProfileId = String(entity.targetProfileId ?? '').trim();
  return targetEmail === email || targetProfileId === ownerId;
};

export default async (ctx: any, _config: unknown, { strapi }: any) => {
  const identity = readIdentity(ctx);
  if (!identity) return denyNoIdentity(ctx);

  const method = String(ctx.request?.method ?? '').toUpperCase();
  const id = String(ctx.params?.id ?? '').trim();

  if (method === 'GET' && !id) {
    mergeScopeOrFilter(ctx, [
      { kind: { $eq: 'broadcast' } },
      { targetEmail: { $eq: identity.email } },
      { targetProfileId: { $eq: identity.ownerId } },
    ]);
    return true;
  }

  if (method === 'POST') {
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const data = (body.data ?? {}) as Record<string, unknown>;

    const kind = String(data.kind ?? '').trim().toLowerCase();
    if (kind === 'broadcast') {
      ctx.forbidden('Broadcast bildirimi sadece yonetim tarafi gonderebilir.');
      return false;
    }

    const targetEmail = normalizeEmail(data.targetEmail);
    const targetProfileId = String(data.targetProfileId ?? '').trim();
    if (targetEmail && targetEmail !== identity.email) {
      ctx.forbidden('Baska kullaniciya bildirim olusturamazsin.');
      return false;
    }
    if (targetProfileId && targetProfileId !== identity.ownerId) {
      ctx.forbidden('Baska profile bildirim olusturamazsin.');
      return false;
    }

    data.targetEmail = identity.email;
    data.targetProfileId = identity.ownerId;
    body.data = data;
    ctx.request.body = body;
    return true;
  }

  if (id) {
    const entity = await loadEntityByRouteId(strapi, UID, id, ['kind', 'targetEmail', 'targetProfileId']);
    if (!entity) {
      ctx.forbidden('Bu bildirim kaydina erisim yetkin yok.');
      return false;
    }
    const kind = String(entity.kind ?? '').trim().toLowerCase();
    const mine = isMine(entity, identity.email, identity.ownerId);

    if (method === 'GET') {
      if (kind === 'broadcast' || mine) return true;
      ctx.forbidden('Bu bildirim kaydina erisim yetkin yok.');
      return false;
    }

    if (!mine || kind === 'broadcast') {
      ctx.forbidden('Bu bildirim kaydini degistirme yetkin yok.');
      return false;
    }
  }

  return true;
};

