export default {
  routes: [
    {
      method: 'GET',
      path: '/logistics-loads/nearby',
      handler: 'logistics-load.nearby',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/logistics-loads/:id/metrics/view',
      handler: 'logistics-load.metricView',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/logistics-loads/:id/metrics/like',
      handler: 'logistics-load.metricLike',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/logistics-loads/:id/metrics/favorite',
      handler: 'logistics-load.metricFavorite',
      config: { auth: { scope: [] } },
    },
  ],
};

