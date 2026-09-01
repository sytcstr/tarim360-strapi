/**
 * Thin controllers for the Engagement API contract v1 (PUT/DELETE
 * like/favorite — Aşama 4). All transaction/atomicity logic lives in
 * ../services/engagement-v1.ts; this file only handles ctx parsing,
 * auth, ENGAGEMENT_NOT_SUPPORTED enforcement, and response shaping.
 */
import { readIdentity, matchesIdentity, loadEntityByRouteId } from '../../../utils/identity';
import {
  assertEngagementSupported,
  buildToggleBody,
  buildViewBody,
  EngagementMembershipKind,
  requireAuthenticatedActorKey,
  resolveActorKey,
  sendEngagementError,
  TARGET_UID,
  VERSION_FIELD,
  VIEW_COUNT_FIELD,
} from '../../../utils/engagement-contract';
import { setMembership } from '../services/engagement-v1';
import { registerView } from '../services/engagement-view-service';
import { resolveTargetRow } from '../services/engagement-core';

const dataBody = (ctx: any): Record<string, unknown> => {
  const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
  const parsed = (body.data && typeof body.data === 'object' ? body.data : body) as Record<
    string,
    unknown
  >;
  // Confirmed via a real boot (Faz B-V): DELETE requests arrive with an
  // EMPTY ctx.request.body in this Strapi/Koa setup, even when the client
  // sends a JSON body — DELETE-with-body support is inconsistent across
  // HTTP clients/proxies/frameworks generally, so query-string parameters
  // are the reliable, standard way to pass targetType/targetId on DELETE.
  // Body values win if both are present (PUT keeps working unchanged).
  const query = (ctx.query ?? {}) as Record<string, unknown>;
  return {
    targetType: parsed.targetType ?? query.targetType,
    targetId: parsed.targetId ?? query.targetId,
    ...parsed,
  };
};

/** Only "listing" ownership is checked in this phase — see
 * ENGAGEMENT_BACKEND_IMPLEMENTATION_REPORT.md known-risks for the other
 * domains' deferred self-action checks. */
const isOwnListingTarget = async (strapiInstance: any, targetId: string, identity: { email: string; ownerId: string }) => {
  const row = await loadEntityByRouteId(strapiInstance, TARGET_UID.listing, targetId, [
    'ownerEmail',
    'ownerProfileId',
    'ownerId',
  ]);
  if (!row) return false;
  return matchesIdentity(row, identity, ['ownerEmail'], ['ownerProfileId', 'ownerId']);
};

const handleMembership = async (
  ctx: any,
  kind: EngagementMembershipKind,
  active: boolean,
) => {
  const identity = readIdentity(ctx);
  if (!identity) return sendEngagementError(ctx, 'UNAUTHORIZED', 'Kimlik dogrulanamadi.');

  const body = dataBody(ctx);
  const targetType = body.targetType;
  const targetId = String(body.targetId ?? '').trim();
  if (!targetId) return sendEngagementError(ctx, 'VALIDATION_ERROR', 'targetId zorunlu.');
  if (!assertEngagementSupported(ctx, targetType, kind)) return;

  if (targetType === 'listing' && active) {
    const ownTarget = await isOwnListingTarget(strapi, targetId, identity);
    if (ownTarget) {
      return sendEngagementError(ctx, 'FORBIDDEN', 'Kendi hedefinizi beğenemez/favorileyemezsiniz.');
    }
    // LISTING_L20_FINAL_TECHNICAL_INTEGRITY_REPORT.md L20.21: findOne()/
    // similar() already 404 a pending/rejected listing for any non-owner
    // -- this endpoint had no equivalent check, so a caller who already
    // had a now-hidden listing's id (a stale bookmark, or a direct API
    // call) could still create a brand-new like/favorite against it even
    // though no normal UI path could ever show them that listing. Scoped
    // to CREATING a new membership only (active=true) -- removing an
    // already-existing like/favorite is left unaffected, matching L18's
    // own precedent that an existing relationship with a listing survives
    // it later becoming non-active.
    const target = await loadEntityByRouteId(strapi, TARGET_UID.listing, targetId, [
      'status',
    ]);
    const status = String((target as any)?.status ?? '').trim().toLowerCase();
    if (target && status !== 'active') {
      return sendEngagementError(ctx, 'NOT_FOUND', `${targetType} bulunamadi: ${targetId}`);
    }
  }

  const actorKey = requireAuthenticatedActorKey(ctx);
  if (!actorKey) return sendEngagementError(ctx, 'UNAUTHORIZED', 'Kimlik dogrulanamadi.');

  const result = await setMembership(strapi, actorKey, targetType, targetId, kind, active);
  if (!result.found) {
    return sendEngagementError(ctx, 'NOT_FOUND', `${targetType} bulunamadi: ${targetId}`);
  }

  ctx.body = buildToggleBody({
    active: result.active,
    changed: result.changed,
    count: result.count,
    targetType,
    targetId,
    updatedAt: result.updatedAt,
    serverVersion: result.serverVersion,
  });
};

export default {
  async putLike(ctx: any) {
    return handleMembership(ctx, 'like', true);
  },
  async deleteLike(ctx: any) {
    return handleMembership(ctx, 'like', false);
  },
  async putFavorite(ctx: any) {
    return handleMembership(ctx, 'favorite', true);
  },
  async deleteFavorite(ctx: any) {
    return handleMembership(ctx, 'favorite', false);
  },

  async postView(ctx: any) {
    const body = dataBody(ctx);
    const targetType = body.targetType;
    const targetId = String(body.targetId ?? '').trim();
    if (!targetId) return sendEngagementError(ctx, 'VALIDATION_ERROR', 'targetId zorunlu.');
    if (!assertEngagementSupported(ctx, targetType, 'view')) return;

    const actorKey = resolveActorKey(ctx);
    if (!actorKey) {
      return sendEngagementError(
        ctx,
        'VALIDATION_ERROR',
        'Kimlik dogrulanamadi ve gecerli bir guestActorId gonderilmedi.',
      );
    }

    // Faz D8-V-B.3 (profile) / LISTING_L9_OWNER_BUYER_ACTION_POLICY_REPORT.md
    // L9.9 (listing): an owner must never inflate their own target's view
    // count. Flutter already skips recording a view for a listing/profile's
    // own owner, but that is a display-layer courtesy, not a security
    // boundary -- a modified or replayed client could otherwise self-view
    // without limit. Scoped to 'profile' and 'listing' only, since those are
    // the only two domains with a real "owner views their own target"
    // concept found in this codebase (forensic confirmed likes/favorites
    // already have an equivalent isOwnListingTarget guard for listings;
    // views did not, until now). registerView/setMembership stay completely
    // untouched otherwise (self-view never becomes a case they need to know
    // about).
    if (targetType === 'listing') {
      // L20.21: same visibility rule as handleMembership above -- fetched
      // unconditionally (not gated behind `identity`) so an ANONYMOUS
      // caller (guestActorId only) is equally blocked from registering a
      // new view against a listing findOne()/similar() would already 404
      // for them.
      const identity = readIdentity(ctx);
      const target = await resolveTargetRow(strapi, targetType, targetId);
      const isOwner =
        !!identity &&
        !!target &&
        matchesIdentity(target, identity, ['ownerEmail'], ['ownerProfileId', 'ownerId']);
      const status = String((target as any)?.status ?? '').trim().toLowerCase();
      if (target && !isOwner && status !== 'active') {
        return sendEngagementError(ctx, 'NOT_FOUND', `${targetType} bulunamadi: ${targetId}`);
      }
      if (target && isOwner) {
        const countField = VIEW_COUNT_FIELD[targetType];
        if (countField) {
          ctx.body = buildViewBody({
            incremented: false,
            count: Math.max(0, Number(target[countField] ?? 0)),
            targetType,
            targetId,
            updatedAt: target.updatedAt ?? new Date().toISOString(),
            serverVersion: Number(target[VERSION_FIELD] ?? 0),
          });
          return;
        }
      }
    } else if (targetType === 'profile') {
      const identity = readIdentity(ctx);
      if (identity) {
        const target = await resolveTargetRow(strapi, targetType, targetId);
        const countField = VIEW_COUNT_FIELD[targetType];
        const isSelfView = !!target && String(target.profileId ?? '').trim() === identity.ownerId;
        if (target && countField && isSelfView) {
          ctx.body = buildViewBody({
            incremented: false,
            count: Math.max(0, Number(target[countField] ?? 0)),
            targetType,
            targetId,
            updatedAt: target.updatedAt ?? new Date().toISOString(),
            serverVersion: Number(target[VERSION_FIELD] ?? 0),
          });
          return;
        }
      }
    }

    const result = await registerView(strapi, actorKey, targetType, targetId);
    if (!result.found) {
      return sendEngagementError(ctx, 'NOT_FOUND', `${targetType} bulunamadi: ${targetId}`);
    }

    ctx.body = buildViewBody({
      incremented: result.incremented,
      count: result.count,
      targetType,
      targetId,
      updatedAt: result.updatedAt,
      serverVersion: result.serverVersion,
    });
  },
};
