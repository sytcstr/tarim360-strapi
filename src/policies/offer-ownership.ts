import {
  denyForbidden,
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
      return denyForbidden(ctx, 'Teklif acan kullanici eslesmiyor.');
    }
    if (requesterProfileId && requesterProfileId !== identity.ownerId) {
      return denyForbidden(ctx, 'Teklif profil kimligi eslesmiyor.');
    }

    data.requesterEmail = identity.email;
    data.requesterProfileId = identity.ownerId;

    // O1 (OFFER_O1_CORE_FIX_REPORT.md / BUG-OFFER-001): same fix as
    // offer.ts's create action, kept consistent here since this policy
    // runs first (on the stock POST /offers route) and independently
    // re-derives the same fields -- the resolved listing owner always
    // wins over client-supplied receiver fields now, not just when both
    // are empty.
    const owner = await resolveListingOwnerByAnyId(
      strapi,
      data.listingId ?? data.listingNo,
    );
    let receiverEmail =
      owner?.email || String(data.receiverEmail ?? '').trim().toLowerCase();
    let receiverProfileId =
      owner?.ownerId || String(data.receiverProfileId ?? '').trim();

    if (!receiverProfileId && receiverEmail) {
      receiverProfileId = ownerIdFromEmail(receiverEmail);
    }

    if (!receiverEmail && !receiverProfileId) {
      return denyForbidden(ctx, 'Teklif alicisi bulunamadi. Ilan sahibi bilgisi eksik.');
    }

    if (
      receiverEmail === identity.email ||
      receiverProfileId === identity.ownerId
    ) {
      return denyForbidden(ctx, 'Kendi ilaniniza teklif veremezsiniz.');
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
      return denyForbidden(ctx, 'Bu teklif kaydina erisim yetkin yok.');
    }
  }

  return true;
};
