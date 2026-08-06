/**
 * Faz D8-V-B — dedicated, narrow profile-view-target lookup.
 *
 * Deliberately NOT added to profile-setting's own router (fully
 * self-scoped by `global::profile-setting-ownership`, which forces every
 * GET back to the caller's own `profileId` -- see that policy's own
 * comments; that is exactly the restriction this endpoint must bypass to
 * be useful) and NOT folded into `engagement-v1.ts` (whose contract is
 * domain-agnostic, while this action's `ownerId -> profileId` lookup is
 * profile-specific). Returns only what a view registration needs --
 * never the full profile-setting document. See
 * `services/engagement-profile-lookup.ts` for the field allowlist.
 */
import { sendEngagementError, CONTRACT_VERSION } from '../../../utils/engagement-contract';
import { resolveProfileViewTarget } from '../services/engagement-profile-lookup';

export default {
  async getViewTarget(ctx: any) {
    const ownerId = String(ctx.params?.ownerId ?? '').trim();
    if (!ownerId) return sendEngagementError(ctx, 'VALIDATION_ERROR', 'ownerId zorunlu.');

    const result = await resolveProfileViewTarget(strapi, ownerId);

    if (result.ambiguous) {
      return sendEngagementError(ctx, 'SERVER_ERROR', 'Profil kaydi belirsiz, destek ekibine bildirildi.');
    }
    if (!result.found) {
      return sendEngagementError(ctx, 'NOT_FOUND', 'Profil bulunamadi.');
    }

    ctx.body = {
      success: true,
      target: { type: 'profile', id: result.documentId },
      viewCount: result.viewCount,
      serverVersion: result.serverVersion,
      contractVersion: CONTRACT_VERSION,
    };
  },
};
