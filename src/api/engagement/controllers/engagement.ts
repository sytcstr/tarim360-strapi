import { readIdentity } from '../../../utils/identity';
import {
  actorKeyFor as logisticsActorKeyFor,
  applyLoadActorMetric,
  resolveLoad as resolveLogisticsLoad,
} from '../../logistics-load/controllers/logistics-load';
import { requireAuthenticatedActorKey } from '../../../utils/engagement-contract';
import { setMembership } from '../services/engagement-v1';

const PROFILE_SETTING_UID = 'api::profile-setting.profile-setting';
const LISTING_UID = 'api::listing.listing';

const asString = (value: unknown): string => String(value ?? '').trim();
const asBool = (value: unknown, fallback = false): boolean => {
  if (typeof value === 'boolean') return value;
  const raw = asString(value).toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(raw)) return true;
  if (['false', '0', 'no', 'off'].includes(raw)) return false;
  return fallback;
};

const dataBody = (ctx: any): Record<string, unknown> => {
  const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
  return (body.data && typeof body.data === 'object' ? body.data : body) as Record<
    string,
    unknown
  >;
};

const normalizeStringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map((row) => asString(row)).filter((row) => row.length > 0)
    : [];

const toggleListValue = (
  current: unknown,
  id: string,
  enabled: boolean,
): { next: string[]; changed: boolean; existed: boolean } => {
  const set = new Set(normalizeStringList(current));
  const existed = set.has(id);
  if (enabled) {
    set.add(id);
  } else {
    set.delete(id);
  }
  return { next: [...set], changed: existed !== enabled, existed };
};

const profileSettingForIdentity = async (strapi: any, identity: any) => {
  const existing = await strapi.db.query(PROFILE_SETTING_UID).findOne({
    where: { profileId: identity.ownerId },
  } as any);
  if (existing) return existing;
  return strapi.entityService.create(PROFILE_SETTING_UID as any, {
    data: {
      profileId: identity.ownerId,
      ownerEmail: identity.email,
      updatedAtClient: new Date().toISOString(),
    },
  });
};

const updateProfileSetting = async (
  strapi: any,
  identity: any,
  data: Record<string, unknown>,
) => {
  const row = await profileSettingForIdentity(strapi, identity);
  await strapi.entityService.update(PROFILE_SETTING_UID as any, row.id, {
    data: {
      ...data,
      updatedAtClient: new Date().toISOString(),
    },
  });
  return strapi.db.query(PROFILE_SETTING_UID).findOne({
    where: { profileId: identity.ownerId },
  } as any);
};

const listingCandidates = (raw: unknown): string[] => {
  const id = asString(raw);
  if (!id) return [];
  const set = new Set<string>([id]);
  for (const prefix of ['strapi_', 'listing_']) {
    if (id.startsWith(prefix)) {
      const trimmed = id.slice(prefix.length).trim();
      if (trimmed) set.add(trimmed);
    }
  }
  const digit = id.match(/(\d+)/)?.[1];
  if (digit) set.add(digit);
  return [...set];
};

const findListingByAnyId = async (strapi: any, rawId: unknown) => {
  for (const id of listingCandidates(rawId)) {
    const numeric = Number(id);
    if (Number.isInteger(numeric) && numeric > 0) {
      try {
        const row = await strapi.entityService.findOne(LISTING_UID as any, numeric as any, {
          fields: ['id', 'documentId', 'listingNo', 'ownerEmail', 'ownerProfileId'],
        });
        if (row) return row;
      } catch (_) {
        // continue
      }
    }
    try {
      const row = await strapi.db.query(LISTING_UID).findOne({
        where: { documentId: id },
      } as any);
      if (row) return row;
    } catch (_) {
      // continue
    }
    if (Number.isInteger(numeric) && numeric > 0) {
      try {
        const row = await strapi.db.query(LISTING_UID).findOne({
          where: { listingNo: numeric },
        } as any);
        if (row) return row;
      } catch (_) {
        // continue
      }
    }
  }
  return null;
};

const updateListingCounter = async (
  strapi: any,
  listingId: string,
  field: 'favoriteCount' | 'likeCount' | 'viewCount',
  delta: number,
) => {
  if (!delta) return;
  const listing = await findListingByAnyId(strapi, listingId);
  if (!listing?.id) return;
  const current = Math.max(0, Number(listing[field] ?? 0) || 0);
  await strapi.entityService.update(LISTING_UID as any, listing.id, {
    data: { [field]: Math.max(0, current + delta) },
  });
};

const toggleProfileList = async (
  ctx: any,
  idField: string,
  payloadField: string,
  stateField: string,
  aliases: string[],
  counter?: { field: 'favoriteCount' | 'likeCount'; listingIdField: string },
  onChanged?: (ctx: any, id: string, enabled: boolean) => Promise<void>,
) => {
  const identity = readIdentity(ctx);
  if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');
  const body = dataBody(ctx);
  const id = asString(body[idField]);
  if (!id) return ctx.badRequest(`${idField} zorunlu.`);
  const enabled = asBool(body[payloadField], true);

  const current = await profileSettingForIdentity(strapi, identity);
  const base = toggleListValue(current[stateField], id, enabled);
  const data: Record<string, unknown> = {
    [stateField]: base.next,
    [`${stateField}UpdatedAt`]: new Date().toISOString(),
  };
  for (const alias of aliases) {
    data[alias] = base.next;
  }

  const next = await updateProfileSetting(strapi, identity, data);
  if (counter && base.changed) {
    await updateListingCounter(
      strapi,
      asString(body[counter.listingIdField]) || id,
      counter.field,
      enabled ? 1 : -1,
    );
  }
  if (onChanged && base.changed) {
    await onChanged(ctx, id, enabled);
  }

  ctx.body = {
    data: {
      ok: true,
      id,
      enabled,
      profileId: identity.ownerId,
      values: next?.[stateField] ?? base.next,
    },
  };
};

/**
 * Aşama 10 (legacy delegation): routes this old endpoint into the new
 * engagement-interaction-backed core (setMembership) instead of the
 * profile-setting-JSON-list mechanism above, so a like/favorite
 * performed via this legacy route and the new PUT/DELETE
 * /engagements/like|favorite route are the SAME action against the SAME
 * source of truth — never two independent counters drifting apart or
 * double-incrementing. Response shape is kept backward-compatible
 * (`{data:{ok,id,enabled,profileId,values}}`) even though the current
 * Flutter client's _postJsonBestEffort only checks the HTTP status code
 * and never actually parses these fields (confirmed while auditing
 * strapi_service.dart) — kept anyway in case another consumer does.
 * `values` is intentionally empty: this route no longer maintains
 * profile-setting's likedListingIds/favoriteListingIds list itself —
 * Flutter's FavoritesStore already keeps that list in sync via its own
 * independent upsertProfileSettings call, so nothing regresses.
 */
const delegateListingMembershipToggle = async (
  ctx: any,
  idField: string,
  payloadField: string,
  kind: 'like' | 'favorite',
) => {
  const identity = readIdentity(ctx);
  if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');
  const body = dataBody(ctx);
  const id = asString(body[idField]);
  if (!id) return ctx.badRequest(`${idField} zorunlu.`);
  const enabled = asBool(body[payloadField], true);

  const actorKey = requireAuthenticatedActorKey(ctx);
  if (!actorKey) return ctx.unauthorized('Kimlik dogrulanamadi.');

  const result = await setMembership(strapi, actorKey, 'listing', id, kind, enabled);
  if (!result.found) return ctx.notFound('listing bulunamadi.');

  ctx.body = {
    data: {
      ok: true,
      id,
      enabled: result.active,
      profileId: identity.ownerId,
      values: [],
    },
  };
};

export default {
  async toggleListingFavorite(ctx: any) {
    return delegateListingMembershipToggle(ctx, 'listingId', 'favorite', 'favorite');
  },

  async toggleProfileFavorite(ctx: any) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');
    const body = dataBody(ctx);
    const profileId = asString(body.profileId);
    if (!profileId) return ctx.badRequest('profileId zorunlu.');
    const enabled = asBool(body.favorite, true);
    const current = await profileSettingForIdentity(strapi, identity);
    const map =
      current.favoriteProfilesMap && typeof current.favoriteProfilesMap === 'object'
        ? { ...current.favoriteProfilesMap }
        : {};
    if (enabled) {
      map[profileId] = true;
    } else {
      delete map[profileId];
    }
    const favoriteProfiles = Object.keys(map);
    await updateProfileSetting(strapi, identity, {
      favoriteProfilesMap: map,
      favoriteProfiles,
      favoriteProfilesUpdatedAt: new Date().toISOString(),
    });
    ctx.body = { data: { ok: true, profileId, favorite: enabled } };
  },

  async toggleListingLike(ctx: any) {
    return delegateListingMembershipToggle(ctx, 'listingId', 'liked', 'like');
  },

  async toggleLogisticsLoadLike(ctx: any) {
    return toggleProfileList(
      ctx,
      'loadId',
      'liked',
      'likedLogisticsLoadIds',
      [],
      undefined,
      async (innerCtx, loadId, enabled) => {
        const actor = logisticsActorKeyFor(innerCtx.state.user);
        if (!actor) return;
        const load = await resolveLogisticsLoad(strapi, loadId);
        if (!load) return;
        await applyLoadActorMetric(strapi, load, actor, 'like', enabled);
      },
    );
  },

  async toggleFarmerQuestionLike(ctx: any) {
    return toggleProfileList(ctx, 'questionId', 'liked', 'likedFarmerQuestionIds', []);
  },

  async toggleProcessedProductLike(ctx: any) {
    return toggleProfileList(ctx, 'productId', 'liked', 'likedProductIds', []);
  },

  async syncProfileShowcasePins(ctx: any) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');
    const body = dataBody(ctx);
    const profileId = asString(body.profileId);
    if (!profileId) return ctx.badRequest('profileId zorunlu.');
    if (profileId !== identity.ownerId) {
      return ctx.forbidden('Sadece kendi vitrin siralamanizi guncelleyebilirsiniz.');
    }
    const pinnedIds = normalizeStringList(body.pinnedIds);
    const pinnedOrder = normalizeStringList(body.pinnedOrder);
    await updateProfileSetting(strapi, identity, {
      showcasePinnedIds: pinnedIds,
      showcasePinnedOrder: JSON.stringify(pinnedOrder),
      updatedAtClient: asString(body.updatedAtClient) || new Date().toISOString(),
    });
    ctx.body = { data: { ok: true, profileId, pinnedIds, pinnedOrder } };
  },

  async syncOfflineListing(ctx: any) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');
    const body = dataBody(ctx);
    const operation = asString(body.operation).toLowerCase();
    const listing =
      body.listing && typeof body.listing === 'object'
        ? ({ ...(body.listing as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    if (!['create', 'update', 'upsert'].includes(operation)) {
      return ctx.badRequest('operation create/update/upsert olmali.');
    }
    if (Object.keys(listing).length === 0) return ctx.badRequest('listing zorunlu.');

    listing.ownerEmail = identity.email;
    listing.ownerProfileId = identity.ownerId;
    listing.ownerId = identity.ownerId;
    listing.updatedAtClient = asString(listing.updatedAtClient) || new Date().toISOString();

    const rawId = listing.id ?? listing.listingId ?? listing.remoteId ?? listing.documentId;
    const existing = rawId ? await findListingByAnyId(strapi, rawId) : null;
    if (existing?.id) {
      const entity = await strapi.entityService.update(LISTING_UID as any, existing.id, {
        data: listing,
      });
      ctx.body = { data: { ok: true, operation: 'update', listing: entity } };
      return;
    }

    const entity = await strapi.entityService.create(LISTING_UID as any, {
      data: listing,
    });
    ctx.body = { data: { ok: true, operation: 'create', listing: entity } };
  },
};
