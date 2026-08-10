/**
 * ad controller
 */

import { factories } from '@strapi/strapi';

const AD_UID = 'api::ad.ad';

/**
 * SEMANTIC_CONTRACT_S2 (audit finding 2.11): ad.ts was a fully stock
 * factories.createCoreController -- zero field guard of any kind. The
 * `ad-owner-write` policy (src/policies/ad-owner-write.ts) only verifies
 * that the caller owns the ad; it never sanitizes the payload. That means
 * any authenticated user who owns an ad (requestedByEmail/submitter/
 * requestedByProfileId/ownerProfileId matches their identity) could PATCH
 * approvalStatus/isApproved/reviewStatus/approved on their own ad to an
 * arbitrary value via a normal PUT /ads/:id -- and approved_ads_repo.dart's
 * own `_isApproved()` gate (approvalStatus === 'approved' OR isApproved
 * OR approved) reads exactly those fields to decide whether an ad is shown
 * in the public Approved Ads feed. So this was a genuine moderation
 * bypass: a user could self-approve their own ad request, not just a
 * theoretical one -- it is only "dormant" today because Flutter's own ad
 * creation UI is compile-time disabled (AppFeatureFlags.enableSmartAds =
 * false, lib/main.dart:991), not because the backend enforces anything.
 * There is no separate ad-admin controller (unlike logistics-admin /
 * processed-admin) -- moderation happens through the Strapi admin panel,
 * which goes through a completely different, already-privileged API
 * surface and is unaffected by this fix.
 *
 * Also stripped here, found via schema inspection while fixing the named
 * finding (disclosed rather than left in place, same as S2.1's isPremium/
 * isPremiumOwner addition to listing.ts): the same set of engagement/
 * analytics counters S2.2 just made Engagement v1-exclusive
 * (impressions) or legacy-ad-event-exclusive (showCount/displayCount/
 * viewCount), plus likes/likeCount/favoriteCount/videoViews/izlenmeCount/
 * engagementVersion and isPremiumOwner (premium-sync.ts-owned, exactly
 * like listing.ts's isPremium/isPremiumOwner). Without this, S2.2's fix
 * would be trivially bypassable by a raw PATCH /ads/:id setting
 * `impressions` directly, regardless of what ad-event.ts does. Not
 * included: ownership/identity fields (requestedByEmail,
 * requestedByProfileId, ownerProfileId, submitter) -- the policy already
 * force-overwrites requestedByEmail/requestedByProfileId on create, and
 * an update-time ownership-field spoof (e.g. rewriting submitter) is a
 * distinct, narrower question from "moderation state" that is out of
 * this item's named scope; flagged in
 * SEMANTIC_CONTRACT_S2_HIGH_FIX_REPORT.md as a follow-up, not fixed here.
 */
const CLIENT_PROTECTED_FIELDS = [
  'approvalStatus',
  'reviewStatus',
  'isApproved',
  'approved',
  'likes',
  'impressions',
  'videoViews',
  'likeCount',
  'favoriteCount',
  'showCount',
  'displayCount',
  'viewCount',
  'izlenmeCount',
  'engagementVersion',
  'isPremiumOwner',
];

const stripClientProtectedFields = (
  data: Record<string, any>,
): Record<string, any> => {
  const next = { ...data };
  for (const field of CLIENT_PROTECTED_FIELDS) delete next[field];
  return next;
};

export default factories.createCoreController(AD_UID as any, () => ({
  async create(ctx: any) {
    const body = (ctx.request?.body ?? {}) as Record<string, any>;
    const input = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, any>;
    ctx.request.body = { data: stripClientProtectedFields(input) };
    return super.create(ctx);
  },

  async update(ctx: any) {
    const body = (ctx.request?.body ?? {}) as Record<string, any>;
    const input = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, any>;
    ctx.request.body = { data: stripClientProtectedFields(input) };
    return super.update(ctx);
  },
}));
