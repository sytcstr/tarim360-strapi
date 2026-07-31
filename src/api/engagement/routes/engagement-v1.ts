/**
 * Engagement API contract v1 routes (ENGAGEMENT_API_CONTRACT.md).
 * Deliberately separate from routes/engagement.ts (the legacy toggle
 * endpoints), which will be updated in Aşama 10 to delegate into the same
 * ../services/engagement-v1.ts core instead of duplicating logic.
 */
export default {
  routes: [
    {
      method: 'PUT',
      path: '/engagements/like',
      handler: 'engagement-v1.putLike',
      config: { auth: { scope: [] } },
    },
    {
      method: 'DELETE',
      path: '/engagements/like',
      handler: 'engagement-v1.deleteLike',
      config: { auth: { scope: [] } },
    },
    {
      method: 'PUT',
      path: '/engagements/favorite',
      handler: 'engagement-v1.putFavorite',
      config: { auth: { scope: [] } },
    },
    {
      method: 'DELETE',
      path: '/engagements/favorite',
      handler: 'engagement-v1.deleteFavorite',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/engagements/view',
      handler: 'engagement-v1.postView',
      config: {
        auth: false,
        // ENGAGEMENT_API_CONTRACT.md §9: this is the highest-risk route
        // (no auth, guests allowed) — minimum abuse protection per
        // Aşama 9. See src/middlewares/engagement-rate-limit.ts for the
        // explicitly-disclosed limitations of this in-memory limiter.
        // 60 req/min per actor-or-IP: generous enough for normal rapid
        // browsing (the 24h dedup already absorbs true duplicate views),
        // tight enough to blunt a naive spam loop.
        middlewares: [
          // Runs first: populates ctx.state.user from a valid JWT if one
          // is sent, without requiring it (Strapi's auth:false skips its
          // own JWT verification entirely — confirmed via a real boot,
          // see src/middlewares/engagement-soft-auth.ts header comment).
          { name: 'global::engagement-soft-auth', config: {} },
          { name: 'global::engagement-rate-limit', config: { windowMs: 60_000, max: 60 } },
        ],
      },
    },
  ],
};
