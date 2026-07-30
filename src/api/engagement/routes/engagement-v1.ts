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
  ],
};
