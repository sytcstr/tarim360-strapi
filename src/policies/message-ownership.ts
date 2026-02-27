import { denyNoIdentity, loadEntityByRouteId, matchesIdentity, mergeScopeOrFilter, normalizeEmail, readIdentity } from '../utils/identity';

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

    const requesterEmail = normalizeEmail(data.requesterEmail);
    const receiverEmail = normalizeEmail(data.receiverEmail);
    const requesterProfileId = String(data.requesterProfileId ?? '').trim();
    const receiverProfileId = String(data.receiverProfileId ?? '').trim();

    const emailParticipantSet = requesterEmail || receiverEmail;
    const profileParticipantSet = requesterProfileId || receiverProfileId;
    const emailContainsMe = requesterEmail === identity.email || receiverEmail === identity.email;
    const profileContainsMe =
      requesterProfileId === identity.ownerId || receiverProfileId === identity.ownerId;

    if ((emailParticipantSet || profileParticipantSet) && !(emailContainsMe || profileContainsMe)) {
      ctx.forbidden('Mesaj katilimci bilgileri aktif oturumla uyusmuyor.');
      return false;
    }

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

