import { denyNoIdentity, loadEntityByRouteId, mergeScopeOrFilter, normalizeEmail, readIdentity } from '../utils/identity';

const UID = 'api::notification.notification';

const normalizeText = (value: unknown): string => String(value ?? '').trim();

const truthy = (value: unknown): boolean =>
  value === true ||
  value === 1 ||
  ['true', '1', 'yes', 'evet'].includes(normalizeText(value).toLowerCase());

const isBroadcast = (entity: Record<string, unknown>) => {
  const kind = normalizeText(entity.kind || entity.type).toLowerCase();
  const audience = normalizeText(entity.audience || entity.targetAudience).toLowerCase();
  return (
    truthy(entity.broadcast) ||
    truthy(entity.isBroadcast) ||
    truthy(entity.targetAll) ||
    kind === 'broadcast' ||
    kind === 'campaign' ||
    kind === 'announcement' ||
    kind === 'duyuru' ||
    kind === 'kampanya' ||
    audience === 'all' ||
    audience === 'all_users' ||
    audience === 'everyone' ||
    audience === 'global'
  );
};

const targetEmailOf = (entity: Record<string, unknown>) =>
  normalizeEmail(entity.targetEmail || entity.receiverEmail || entity.recipientEmail || entity.ownerEmail || entity.email);

const targetProfileIdOf = (entity: Record<string, unknown>) =>
  normalizeText(entity.targetProfileId || entity.receiverProfileId || entity.recipientProfileId || entity.ownerProfileId || entity.profileId);

const isMine = (entity: Record<string, unknown>, email: string, ownerId: string) => {
  const targetEmail = targetEmailOf(entity);
  const targetProfileId = targetProfileIdOf(entity);
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
      { kind: { $eq: 'campaign' } },
      { kind: { $eq: 'announcement' } },
      { broadcast: { $eq: true } },
      { isBroadcast: { $eq: true } },
      { targetAll: { $eq: true } },
      { audience: { $eq: 'all' } },
      { targetAudience: { $eq: 'all_users' } },
      { targetEmail: { $eq: identity.email } },
      { receiverEmail: { $eq: identity.email } },
      { recipientEmail: { $eq: identity.email } },
      { targetProfileId: { $eq: identity.ownerId } },
      { receiverProfileId: { $eq: identity.ownerId } },
      { recipientProfileId: { $eq: identity.ownerId } },
      { ownerProfileId: { $eq: identity.ownerId } },
    ]);
    return true;
  }

  if (method === 'POST') {
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const data = (body.data ?? {}) as Record<string, unknown>;

    if (isBroadcast(data)) {
      ctx.forbidden('Toplu bildirim sadece yonetim tarafi gonderebilir.');
      return false;
    }

    let targetEmail = targetEmailOf(data);
    let targetProfileId = targetProfileIdOf(data);

    if (!targetEmail && !targetProfileId) {
      targetEmail = identity.email;
      targetProfileId = identity.ownerId;
    }

    data.targetEmail = targetEmail;
    data.targetProfileId = targetProfileId;
    if (targetEmail && !normalizeEmail(data.receiverEmail)) data.receiverEmail = targetEmail;
    if (targetProfileId && !normalizeText(data.receiverProfileId)) data.receiverProfileId = targetProfileId;
    data.senderEmail = identity.email;
    data.senderProfileId = identity.ownerId;
    body.data = data;
    ctx.request.body = body;
    return true;
  }

  if (id) {
    const entity = await loadEntityByRouteId(strapi, UID, id, [
      'kind',
      'type',
      'targetEmail',
      'targetProfileId',
      'receiverEmail',
      'receiverProfileId',
      'recipientEmail',
      'recipientProfileId',
      'ownerProfileId',
      'broadcast',
      'isBroadcast',
      'targetAll',
      'audience',
      'targetAudience',
    ]);
    if (!entity) {
      ctx.forbidden('Bu bildirim kaydina erisim yetkin yok.');
      return false;
    }
    const mine = isMine(entity, identity.email, identity.ownerId);

    if (method === 'GET') {
      if (isBroadcast(entity) || mine) return true;
      ctx.forbidden('Bu bildirim kaydina erisim yetkin yok.');
      return false;
    }

    if (!mine || isBroadcast(entity)) {
      ctx.forbidden('Bu bildirim kaydini degistirme yetkin yok.');
      return false;
    }
  }

  return true;
};
