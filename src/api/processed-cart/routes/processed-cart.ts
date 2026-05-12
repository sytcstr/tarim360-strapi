export default {
  routes: [
    {
      method: 'GET',
      path: '/processed-cart/mine',
      handler: 'processed-cart.mine',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/processed-cart/sync',
      handler: 'processed-cart.sync',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/processed-cart/clear',
      handler: 'processed-cart.clear',
      config: { auth: { scope: [] } },
    },
  ],
};
