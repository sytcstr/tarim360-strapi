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
    const query = (ctx.query ?? {}) as Record<string, unknown>;
    const filters = (query.filters ?? {}) as Record<string, unknown>;
    ctx.query = {
      ...query,
      filters: {
        ...filters,
        profileId: { $eq: identity.ownerId },
      },
    };
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
