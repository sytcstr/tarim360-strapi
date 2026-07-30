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
} from '../../../utils/engagement-contract';
import { setMembership } from '../services/engagement-v1';
import { registerView } from '../services/engagement-view-service';

const dataBody = (ctx: any): Record<string, unknown> => {
  const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
  return (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, unknown>;
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
