export default {
  routes: [
    {
      method: 'GET',
      path: '/market/snapshot',
      handler: 'market.snapshot',
      config: { auth: false },
    },
  ],
};
