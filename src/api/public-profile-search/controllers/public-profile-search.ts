import { sendEngagementError, CONTRACT_VERSION } from '../../../utils/engagement-contract';
import { searchPublicProfiles } from '../services/public-profile-search';

export default {
  async search(ctx: any) {
    const q = String(ctx.query?.q ?? '').trim();
    if (q.length < 2) {
      ctx.body = { success: true, profiles: [], contractVersion: CONTRACT_VERSION };
      return;
    }
    try {
      const profiles = await searchPublicProfiles(strapi, q);
      ctx.body = { success: true, profiles, contractVersion: CONTRACT_VERSION };
    } catch (e: any) {
      strapi.log.error(`[public-profile-search] search failed: ${e?.message ?? e}`);
      sendEngagementError(ctx, 'SERVER_ERROR', 'Arama şu anda yapılamadı.');
    }
  },
};
