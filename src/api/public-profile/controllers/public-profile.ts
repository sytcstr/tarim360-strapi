/**
 * PUB-PROFILE-B — dedicated, narrow public profile read.
 *
 * Deliberately NOT added to profile-setting's own router (self-scoped by
 * global::profile-setting-ownership -- whose GET-list branch was exactly
 * the SEC-1 bypass; this endpoint must never depend on or route through
 * that policy) and not folded into any other controller. Returns only
 * the allowlisted fields from services/public-profile.ts -- never the
 * full profile-setting document.
 */
import { sendEngagementError, CONTRACT_VERSION } from '../../../utils/engagement-contract';
import { resolvePublicProfile } from '../services/public-profile';

export default {
  async getPublicProfile(ctx: any) {
    const ownerId = String(ctx.params?.ownerId ?? '').trim();
    if (!ownerId) return sendEngagementError(ctx, 'VALIDATION_ERROR', 'ownerId zorunlu.');

    const result = await resolvePublicProfile(strapi, ownerId);

    if (result.ambiguous) {
      return sendEngagementError(ctx, 'SERVER_ERROR', 'Profil kaydi belirsiz, destek ekibine bildirildi.');
    }
    if (!result.found || !result.profile) {
      return sendEngagementError(ctx, 'NOT_FOUND', 'Profil bulunamadi.');
    }

    ctx.body = {
      success: true,
      profile: result.profile,
      contractVersion: CONTRACT_VERSION,
    };
  },
};
