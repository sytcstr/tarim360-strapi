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
 * SEMANTIC_CONTRACT_S2 (audit finding 2.5): unlike processed-product,
 * logistics-vehicle, and hub-content -- which all strip their engagement-
 * only fields from create/update -- listing.ts had NO update override at
 * all (stock factories.createCoreController), so any authenticated owner
 * could PATCH their own listing's likeCount/favoriteCount/viewCount/
 * offerCount/commentCount/shareCount/engagementVersion to an arbitrary
 * value via a normal PUT /listings/:id. engagement_interactions (via
 * setMembership/incrementCounterAtomic) and listing-metrics.ts's
 * recountListingOffers are the only real sources of truth for these
 * counters now.
 *
 * Also strips isPremium/isPremiumOwner -- the exact same "no update
 * guard" gap, in the exact same controller, letting any owner grant
 * their own listing a premium badge without actually being premium.
 * These are premium-sync.ts-owned, not engagement-v1-owned, but the
 * vulnerability class and the fix are identical; disclosed here rather
 * than silently left in place. Not included: isDoping/rocketEndsAt (a
 * separate rocket/promotion mechanism, not part of this audit item --
 * flagged in SEMANTIC_CONTRACT_S2_HIGH_FIX_REPORT.md as a follow-up, not
 * fixed here).
 */
const CLIENT_PROTECTED_FIELDS = [
  'likeCount',
  'favoriteCount',
  'viewCount',
  'offerCount',
  'commentCount',
  'shareCount',
  'engagementVersion',
  'isPremium',
  'isPremiumOwner',
];

const stripClientProtectedFields = (
  data: Record<string, any>,
): Record<string, any> => {
  const next = { ...data };
  for (const field of CLIENT_PROTECTED_FIELDS) delete next[field];
  return next;
};

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
          ...stripClientProtectedFields(input),
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

    async update(ctx) {
      const body = (ctx.request?.body ?? {}) as Record<string, any>;
      const input = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, any>;
      ctx.request.body = { data: stripClientProtectedFields(input) };
      return super.update(ctx);
    },
  }),
);
