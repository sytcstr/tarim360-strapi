import {
  denyForbidden,
  denyNoIdentity,
  loadEntityByRouteId,
  readIdentity,
} from '../utils/identity';

const UID = 'api::profile-setting.profile-setting';

export default async (ctx: any, _config: unknown, { strapi }: any) => {
  const identity = readIdentity(ctx);
  if (!identity) return denyNoIdentity(ctx);

  const method = String(ctx.request?.method ?? '').toUpperCase();
  const id = String(ctx.params?.id ?? '').trim();

  if (method === 'GET' && !id) {
    // SEC-1 fix: this branch previously only assigned `ctx.query = {...}`.
    // Confirmed via a real boot (debug instrumentation, not a guess) that
    // in Strapi's policy execution context `ctx.query` and
    // `ctx.request.query` are NOT the same delegated property the way
    // they are on a vanilla Koa context: `ctx.query` here starts out
    // `undefined` even with a real querystring on the request, and
    // Strapi's core `find` controller reads the filter from
    // `ctx.request.query` — which the old code never touched. The result
    // was that this entire branch was a no-op: whatever `filters` the
    // client sent was honored exactly as sent, completely unrestricted by
    // identity. Any authenticated caller could read any other user's full
    // profile-setting document (phone, bio, favorites, follow lists,
    // etc.) via GET /profile-settings?filters[profileId][$eq]=<target> --
    // or, as this fix's own regression coverage proves, via a filter on
    // ANY field, not just profileId (the client's filters object as a
    // whole was never constrained). Both `ctx.query` and
    // `ctx.request.query` are now set so this holds regardless of which
    // one a given Strapi core action reads from.
    const query = (ctx.request?.query ?? {}) as Record<string, unknown>;
    const forced = {
      ...query,
      filters: { profileId: { $eq: identity.ownerId } },
    };
    ctx.query = forced;
    ctx.request.query = forced;
    return true;
  }

  if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const data = (body.data ?? {}) as Record<string, unknown>;
    const providedProfileId = String(data.profileId ?? '').trim();
    if (providedProfileId && providedProfileId !== identity.ownerId) {
      return denyForbidden(ctx, 'Baska profile ait ayari degistiremezsin.');
    }
    data.profileId = identity.ownerId;
    body.data = data;
    ctx.request.body = body;
  }

  if (id) {
    const entity = await loadEntityByRouteId(strapi, UID, id, ['profileId']);
    const profileId = String(entity?.profileId ?? '').trim();
    if (profileId != identity.ownerId) {
      return denyForbidden(ctx, 'Bu profil ayarina erisim yetkin yok.');
    }
  }

  return true;
};
