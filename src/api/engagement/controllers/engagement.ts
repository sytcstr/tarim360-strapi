import { matchesIdentity, readIdentity } from '../../../utils/identity';
import {
  applyLoadActorMetric,
  resolveLoad as resolveLogisticsLoad,
} from '../../logistics-load/controllers/logistics-load';
import { requireAuthenticatedActorKey } from '../../../utils/engagement-contract';
import { setMembership } from '../services/engagement-v1';
import {
  canCreateNextNormalListing,
  nextListingNo,
  NORMAL_LISTING_BLOCK_SIZE,
  NORMAL_LISTING_FREE_COUNT,
  stripListingProtectedFields,
} from '../../../utils/listing-metrics';
import { isPremiumActiveFromProfile, loadPremiumProfile } from '../../../utils/premium-sync';

const PROFILE_SETTING_UID = 'api::profile-setting.profile-setting';
const LISTING_UID = 'api::listing.listing';
const LISTING_CREATE_OPERATION_UID =
  'api::listing-create-operation.listing-create-operation';

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
          fields: ['id', 'documentId', 'listingNo', 'ownerEmail', 'ownerProfileId', 'ownerId'],
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

  /**
   * Faz D4-B (legacy delegation): this route's real mutation is now the
   * same setMembership-backed applyLoadActorMetric core the new
   * POST /logistics-loads/:id/metrics/like route uses (see
   * logistics-load.ts) — never an independent counter write. The
   * profile-setting likedLogisticsLoadIds list is kept for backward
   * compatibility (old clients may still read it), but it is updated
   * strictly from the server's own result (result.active/result.changed),
   * never from the client's requested `liked` value — so a stale/duplicate
   * client request can never desync it from the real interaction state.
   */
  async toggleLogisticsLoadLike(ctx: any) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');
    const body = dataBody(ctx);
    const loadId = asString(body.loadId);
    if (!loadId) return ctx.badRequest('loadId zorunlu.');
    const enabled = asBool(body.liked, true);

    const actorKey = requireAuthenticatedActorKey(ctx);
    if (!actorKey) return ctx.unauthorized('Kimlik dogrulanamadi.');

    const load = await resolveLogisticsLoad(strapi, loadId);
    if (!load) return ctx.notFound('Lojistik yuk bulunamadi.');

    const { result } = await applyLoadActorMetric(strapi, load, actorKey, 'like', enabled);
    if (!result.found) return ctx.notFound('Lojistik yuk bulunamadi.');

    let values: string[] = [];
    if (result.changed) {
      const current = await profileSettingForIdentity(strapi, identity);
      const base = toggleListValue(current.likedLogisticsLoadIds, loadId, result.active);
      const next = await updateProfileSetting(strapi, identity, {
        likedLogisticsLoadIds: base.next,
        likedLogisticsLoadIdsUpdatedAt: new Date().toISOString(),
      });
      values = (next?.likedLogisticsLoadIds as string[]) ?? base.next;
    }

    ctx.body = {
      data: {
        ok: true,
        id: loadId,
        enabled: result.active,
        profileId: identity.ownerId,
        values,
      },
    };
  },

  /**
   * Faz D7-B (legacy delegation): same pattern as toggleLogisticsLoadLike/
   * toggleProcessedProductLike — the real mutation is now setMembership,
   * not a profile-setting-only list write. Farmer Questions have NO
   * dedicated content-type of their own: they are rows in
   * api::hub-content.hub-content with kind='farmerQuestion'
   * (FarmerQuestionsRepo.toQuestionPayload, Flutter) — the exact same
   * collection/UID Faz D6 already wired to targetType='hub-content'. A
   * separate 'farmer-question' targetType was deliberately NOT created:
   * it would let the identical physical row be liked through two
   * independent engagement_interactions namespaces while both drove the
   * same `likes` column — a structural double-count risk. This route
   * therefore delegates to targetType='hub-content', the same target
   * Knowledge Hub content already uses; `kind` is irrelevant at the
   * engagement layer, it only matters for Flutter's own UI filtering.
   */
  async toggleFarmerQuestionLike(ctx: any) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');
    const body = dataBody(ctx);
    const questionId = asString(body.questionId);
    if (!questionId) return ctx.badRequest('questionId zorunlu.');
    const enabled = asBool(body.liked, true);

    const actorKey = requireAuthenticatedActorKey(ctx);
    if (!actorKey) return ctx.unauthorized('Kimlik dogrulanamadi.');

    const result = await setMembership(strapi, actorKey, 'hub-content', questionId, 'like', enabled);
    if (!result.found) return ctx.notFound('Soru bulunamadi.');

    let values: string[] = [];
    if (result.changed) {
      const current = await profileSettingForIdentity(strapi, identity);
      const base = toggleListValue(current.likedFarmerQuestionIds, questionId, result.active);
      const next = await updateProfileSetting(strapi, identity, {
        likedFarmerQuestionIds: base.next,
        likedFarmerQuestionIdsUpdatedAt: new Date().toISOString(),
      });
      values = (next?.likedFarmerQuestionIds as string[]) ?? base.next;
    }

    ctx.body = {
      data: {
        ok: true,
        id: questionId,
        enabled: result.active,
        profileId: identity.ownerId,
        values,
      },
    };
  },

  /**
   * Faz D5-B (legacy delegation): same pattern as toggleLogisticsLoadLike —
   * the real mutation is now setMembership (engagement_interactions +
   * atomic likeCount increment), not a profile-setting-only list write.
   * Unlike logistics-load, processed-product never had a dedicated
   * /metrics/like route or a JSON actor-list mirror — its only pre-D5-B
   * "counter" mechanism was the Flutter client computing likeCount/
   * favoriteCount/viewCount locally and PATCHing them via the generic
   * core update route (see processed-product.ts's stripEngagementFields),
   * which never actually updated this content-type's real counters in a
   * race-safe way. This route is the one dedicated legacy entry point
   * that could still be called by an old client.
   */
  async toggleProcessedProductLike(ctx: any) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');
    const body = dataBody(ctx);
    const productId = asString(body.productId);
    if (!productId) return ctx.badRequest('productId zorunlu.');
    const enabled = asBool(body.liked, true);

    const actorKey = requireAuthenticatedActorKey(ctx);
    if (!actorKey) return ctx.unauthorized('Kimlik dogrulanamadi.');

    const result = await setMembership(strapi, actorKey, 'processed-product', productId, 'like', enabled);
    if (!result.found) return ctx.notFound('Islenmis urun bulunamadi.');

    let values: string[] = [];
    if (result.changed) {
      const current = await profileSettingForIdentity(strapi, identity);
      const base = toggleListValue(current.likedProductIds, productId, result.active);
      const next = await updateProfileSetting(strapi, identity, {
        likedProductIds: base.next,
        likedProductIdsUpdatedAt: new Date().toISOString(),
      });
      values = (next?.likedProductIds as string[]) ?? base.next;
    }

    ctx.body = {
      data: {
        ok: true,
        id: productId,
        enabled: result.active,
        profileId: identity.ownerId,
        values,
      },
    };
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

  /**
   * LISTING_SYSTEM_RELEASE_FORENSIC_AUDIT.md BUG-LISTING-001 (CRITICAL):
   * this offline-queue write path (Flutter's ListingPendingSyncQueue)
   * previously had NO ownership check on the `update`/`upsert` branch --
   * `findListingByAnyId` resolved the target purely by id/documentId/
   * listingNo, with no comparison against the caller's identity -- and
   * NO field protection at all (stripClientProtectedFields was never
   * called here, unlike listing.ts's own create/update). Any
   * authenticated caller who knew/guessed another listing's id could
   * reassign that listing to their own account (ownerEmail/
   * ownerProfileId/ownerId were overwritten to the CALLER's identity)
   * and freely set isPremium/isDoping/rocketEndsAt/every counter/status
   * on it. Fixed: ownership is now verified via matchesIdentity before
   * any update (403 if the resolved row isn't the caller's own), and
   * stripListingProtectedFields runs on both the create and update
   * paths -- the exact same protection listing.ts's own routes have.
   */
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

    const rawId = listing.id ?? listing.listingId ?? listing.remoteId ?? listing.documentId;
    const existing = rawId ? await findListingByAnyId(strapi, rawId) : null;

    // The client's own id/documentId/listingId/remoteId must never reach
    // `data` -- the target row is already selected via `existing.id`
    // below; including a client-supplied `id` in the update payload can
    // make Strapi attempt to move the row to a DIFFERENT primary key
    // (confirmed live while writing this fix's tests: a client-echoed
    // `id` field caused a genuine "UNIQUE constraint failed: listings.id"
    // error instead of a normal field update).
    const safeListing = stripListingProtectedFields(listing);
    delete safeListing.id;
    delete safeListing.documentId;
    delete safeListing.listingId;
    delete safeListing.remoteId;
    safeListing.ownerEmail = identity.email;
    safeListing.ownerProfileId = identity.ownerId;
    safeListing.ownerId = identity.ownerId;
    safeListing.updatedAtClient = asString(listing.updatedAtClient) || new Date().toISOString();

    if (existing?.id) {
      const isOwner = matchesIdentity(
        existing,
        identity,
        ['ownerEmail'],
        ['ownerProfileId', 'ownerId'],
      );
      if (!isOwner) return ctx.forbidden('Bu ilan size ait degil.');

      const entity = await strapi.entityService.update(LISTING_UID as any, existing.id, {
        data: safeListing,
      });
      ctx.body = { data: { ok: true, operation: 'update', listing: entity } };
      return;
    }

    // PRE_UAT_F1_TARGETED_FUNCTIONAL_FIX_REPORT.md F1.6: this is the
    // offline-retry path -- the client's local id will never match a
    // listing that was actually already created by a prior POST /listings
    // call the client only THOUGHT had failed (a client-side timeout with
    // no response, not a real server-side failure). Before creating a
    // second, duplicate listing, check the same listing-create-operation
    // ledger listing.ts's create() already writes to, keyed by the same
    // operationId the client is required to carry through this retry.
    if (operation === 'create') {
      const operationId = asString(listing.operationId);
      if (operationId) {
        const ledger = await strapi.db
          .query(LISTING_CREATE_OPERATION_UID)
          .findOne({ where: { operationId } } as any);
        const linkedDocumentId = asString(ledger?.listingDocumentId);
        if (linkedDocumentId) {
          const alreadyCreated = await findListingByAnyId(strapi, linkedDocumentId);
          if (alreadyCreated?.id) {
            ctx.body = {
              data: { ok: true, operation: 'create', listing: alreadyCreated, idempotent: true },
            };
            return;
          }
        }
      }

      // FINAL_R1_TARGETED_RELEASE_FIX_REPORT.md R1.2 (FINAL-BUG-002): this
      // offline-queue create is a second real way to create a listing row,
      // entirely separate from listing.ts's own create() -- it must
      // enforce the exact same free-tier quota, or the quota gate there is
      // trivially bypassed by simply calling this endpoint instead.
      const premiumProfile = await loadPremiumProfile(strapi, identity);
      if (!isPremiumActiveFromProfile(premiumProfile)) {
        const canCreate = await canCreateNextNormalListing(
          strapi,
          identity.ownerId,
        );
        if (!canCreate) {
          return ctx.forbidden(
            `Normal hesapta ilk ${NORMAL_LISTING_FREE_COUNT} ilan ucretsizdir. Yeni ilan acmak icin ${NORMAL_LISTING_BLOCK_SIZE} ilan hakki paketi satin almalisin.`,
          );
        }
      }
    }

    // LISTING_L3_LISTING_TYPE_AND_PUBLIC_NUMBER_REPORT.md L3.5/L3.7: this
    // offline-queue create is a second real creation path, exactly the
    // same reasoning as the quota check above -- it must also assign a
    // real server-generated listingNo, not trust whatever (if anything)
    // the client queued. Same bounded-retry-on-collision shape as
    // listing.ts's own create().
    const MAX_LISTING_NO_ATTEMPTS = 5;
    let entity: any;
    let lastCreateError: unknown = null;
    for (let attempt = 0; attempt < MAX_LISTING_NO_ATTEMPTS; attempt++) {
      const listingNo = await nextListingNo(strapi);
      try {
        entity = await strapi.entityService.create(LISTING_UID as any, {
          data: { ...safeListing, listingNo },
        });
        lastCreateError = null;
        break;
      } catch (e) {
        lastCreateError = e;
      }
    }
    if (lastCreateError) throw lastCreateError;
    ctx.body = { data: { ok: true, operation: 'create', listing: entity } };
  },
};
