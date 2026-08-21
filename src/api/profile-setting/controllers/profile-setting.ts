/**
 * profile-setting controller
 */

import { factories } from '@strapi/strapi';

const UID = 'api::profile-setting.profile-setting';

/**
 * ENGAGEMENT_E2_TARGETED_FIX_REPORT.md BUG-ENG-007: viewCount/
 * engagementVersion must never be settable through the generic create/
 * update actions -- the canonical `POST /engagements/view` flow
 * (engagement-view-service.ts, via db.query/db.transaction directly,
 * never through this controller) is the only real source of truth for
 * these fields. Without this guard a user could PUT their own
 * profile-setting row with an arbitrary viewCount to self-inflate a
 * publicly-displayed number. Mirrors the same pattern already used by
 * listing/logistics/processed-product controllers.
 */
const ENGAGEMENT_ONLY_FIELDS = ['viewCount', 'engagementVersion'];

const stripEngagementFields = (data: Record<string, any>): Record<string, any> => {
  const next = { ...data };
  for (const field of ENGAGEMENT_ONLY_FIELDS) delete next[field];
  return next;
};

export default factories.createCoreController(UID as any, () => ({
  async create(ctx: any) {
    const body = (ctx.request?.body ?? {}) as Record<string, any>;
    const input = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, any>;
    ctx.request.body = { data: stripEngagementFields(input) };
    return super.create(ctx);
  },

  async update(ctx: any) {
    const body = (ctx.request?.body ?? {}) as Record<string, any>;
    const input = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, any>;
    ctx.request.body = { data: stripEngagementFields(input) };
    return super.update(ctx);
  },
}));
