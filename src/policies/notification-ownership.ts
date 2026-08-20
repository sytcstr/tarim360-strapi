import { denyForbidden, denyNoIdentity, loadEntityByRouteId, mergeScopeOrFilter, normalizeEmail, readIdentity } from '../utils/identity';

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
    // NOTIFICATION_N1_SECURITY_FIX_REPORT.md BUG-NOTIF-001 (CRITICAL): this
    // branch used to accept a client-supplied targetEmail/targetProfileId
    // as-is whenever either was non-empty, only forcing the SENDER fields
    // server-side -- letting any authenticated user create a notification
    // (and, via this content-type's own afterCreate -> deliverPush, a real
    // FCM push) addressed to an arbitrary victim. The generic, client-
    // reachable create endpoint is now self-target-only: a client can only
    // ever create a notification for themselves through this route. Every
    // legitimate cross-user notification (message, offer, support-reply,
    // admin broadcast, and the "social interaction" producers formerly
    // routed through this same endpoint) is created by trusted backend
    // code directly via entityService/db.query, or through the new,
    // per-domain-verified api::notification.notification.createDomainEvent
    // action (see notification.ts) -- never through this policy-gated
    // public route.
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const data = (body.data ?? {}) as Record<string, unknown>;

    if (isBroadcast(data)) {
      return denyForbidden(ctx, 'Toplu bildirim sadece yonetim tarafi gonderebilir.');
    }

    const claimedEmail = targetEmailOf(data);
    const claimedProfileId = targetProfileIdOf(data);
    const claimsOther =
      (claimedEmail && claimedEmail !== identity.email) ||
      (claimedProfileId && claimedProfileId !== identity.ownerId);
    if (claimsOther) {
      return denyForbidden(ctx, 'Baska bir kullaniciya bildirim olusturamazsiniz.');
    }

    data.targetEmail = identity.email;
    data.targetProfileId = identity.ownerId;
    data.receiverEmail = identity.email;
    data.receiverProfileId = identity.ownerId;
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
      return denyForbidden(ctx, 'Bu bildirim kaydina erisim yetkin yok.');
    }
    const mine = isMine(entity, identity.email, identity.ownerId);

    if (method === 'GET') {
      if (isBroadcast(entity) || mine) return true;
      return denyForbidden(ctx, 'Bu bildirim kaydina erisim yetkin yok.');
    }

    if (!mine || isBroadcast(entity)) {
      return denyForbidden(ctx, 'Bu bildirim kaydini degistirme yetkin yok.');
    }
  }

  return true;
};
