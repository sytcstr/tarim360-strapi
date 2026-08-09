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

    // Faz D8-V-B.3: a profile's own owner must never inflate their own
    // view count. Flutter's HesabimPage already skips recording a view for
    // its own owner, but that is a display-layer courtesy, not a security
    // boundary -- a modified or replayed client could otherwise self-view
    // without limit. This check is deliberately scoped to targetType
    // 'profile' only; no other domain in this contract has an "owner views
    // their own target" concept, and registerView/setMembership stay
    // completely untouched (self-view never becomes a case they need to
    // know about).
    if (targetType === 'profile') {
      const identity = readIdentity(ctx);
      if (identity) {
        const target = await resolveTargetRow(strapi, 'profile', targetId);
        const countField = VIEW_COUNT_FIELD.profile;
        if (target && countField && String(target.profileId ?? '').trim() === identity.ownerId) {
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
