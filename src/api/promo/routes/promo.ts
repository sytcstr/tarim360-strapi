export default {
  routes: [
    {
      method: 'POST',
      path: '/promos/redeem',
      handler: 'promo.redeem',
      config: {
        auth: { scope: [] },
      }
    }
  ]
};
