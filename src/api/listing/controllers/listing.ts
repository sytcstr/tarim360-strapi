/**
 * listing controller
 */

import { factories } from '@strapi/strapi';
import { normalizeEmail, ownerIdFromEmail, readIdentity } from '../../../utils/identity';
import { isPremiumActiveFromProfile } from '../../../utils/premium-sync';

const LISTING_UID = 'api::listing.listing';
const PROFILE_UID = 'api::profile-setting.profile-setting';

const clean = (value: unknown): string => String(value ?? '').trim();

/**
 * SEMANTIC_CONTRACT_S1: delegates entirely to premium-sync.ts's canonical
 * rule (missing endsAt = active/unlimited) instead of a separate, stricter
 * local reimplementation (the old version returned false for a missing
 * endsAt, stamping isPremium:false on a brand-new listing for exactly the
 * members the canonical rule -- and premium-sync.ts's own resync of this
 * member's EXISTING listings -- consider active). See
 * SEMANTIC_CONTRACT_S1_CRITICAL_FIX_REPORT.md.
 */
const hasActivePremiumExpiry = (
  profile: Record<string, unknown> | null,
): boolean => isPremiumActiveFromProfile(profile);

const findProfileForIdentity = async (
  strapi: any,
  email: string,
  ownerId: string,
) => {
  const rows = await strapi.entityService.findMany(PROFILE_UID as any, {
    filters: {
      $or: [{ profileId: ownerId }, { ownerEmail: email }],
    },
    fields: [
      'profileId',
      'ownerEmail',
      'activePremium',
      'activePremiumSubscription',
    ],
    limit: 1,
  } as any);
  return (Array.isArray(rows) ? rows[0] : rows) as
    | Record<string, unknown>
    | null;
};

export default factories.createCoreController(
  LISTING_UID,
  ({ strapi }) => ({
    async create(ctx) {
      const identity = readIdentity(ctx);
      if (!identity) return ctx.unauthorized('Oturum gerekli.');

      const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
      const input = (body.data ?? body) as Record<string, unknown>;
      const profile = await findProfileForIdentity(
        strapi,
        identity.email,
        identity.ownerId,
      );

      const ownerProfileId =
        clean(profile?.profileId) ||
        identity.ownerId ||
        ownerIdFromEmail(identity.email);
      const isPremium = hasActivePremiumExpiry(profile);
      const publishedAt = new Date().toISOString();

      ctx.request.body = {
        data: {
          ...input,
          ownerProfileId,
          ownerId: ownerProfileId,
          ownerEmail: normalizeEmail(identity.email),
          isPremium,
          isPremiumOwner: isPremium,
          status: 'active',
          publishedAt,
        },
      };
      ctx.query = {
        ...(ctx.query ?? {}),
        status: 'published',
      };

      return super.create(ctx);
    },
  }),
);
