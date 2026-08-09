/**
 * hub-content controller
 */

import { factories } from '@strapi/strapi';

const UID = 'api::hub-content.hub-content';

/**
 * Faz D6-B: `likes` (and `engagementVersion`) must never be settable
 * through the generic create/update actions. engagement_interactions
 * (via setMembership) is the only real source of truth for the like
 * counter now; the pre-D6 Flutter client (HubContentRepo._syncLike)
 * still PATCHes a client-computed absolute `likes` value here as a
 * best-effort sync — unlike the equivalent processed-product gap (Faz
 * D5-B), this one is NOT blocked by a missing permission:
 * hub-content.update is granted to the authenticated role (src/index.ts),
 * and hub-content-write-guard's "reaction-only update" allowance means
 * this path is live and reachable today, not just theoretically so.
 *
 * Only `likes`/`engagementVersion` are stripped — every comment-related
 * field (`comments`, `commentCount`, `commentList`, `lastCommentText`,
 * `lastCommentAuthor`, `lastCommentAt`) goes through this exact same
 * generic update action (HubContentRepo.addComment/_syncCommentListToStrapi)
 * and must keep working unchanged; the comment system is explicitly out
 * of scope for Faz D6.
 */
const ENGAGEMENT_ONLY_FIELDS = ['likes', 'engagementVersion'];

const stripEngagementFields = (data: Record<string, any>): Record<string, any> => {
  const next = { ...data };
  for (const field of ENGAGEMENT_ONLY_FIELDS) delete next[field];
  return next;
};

export default factories.createCoreController(UID as any, ({ strapi }) => ({
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
