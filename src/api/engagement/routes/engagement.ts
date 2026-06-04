export default {
  routes: [
    {
      method: 'POST',
      path: '/listing-favorites/toggle',
      handler: 'engagement.toggleListingFavorite',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/profile-favorites/toggle',
      handler: 'engagement.toggleProfileFavorite',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/listing-likes/toggle',
      handler: 'engagement.toggleListingLike',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/logistics-load-likes/toggle',
      handler: 'engagement.toggleLogisticsLoadLike',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/farmer-question-likes/toggle',
      handler: 'engagement.toggleFarmerQuestionLike',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/processed-product-likes/toggle',
      handler: 'engagement.toggleProcessedProductLike',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/profile-showcase-pins/sync',
      handler: 'engagement.syncProfileShowcasePins',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/offline-sync/listings',
      handler: 'engagement.syncOfflineListing',
      config: { auth: { scope: [] } },
    },
  ],
};
