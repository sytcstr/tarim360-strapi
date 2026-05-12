export default {
  routes: [
    {
      method: 'GET',
      path: '/processed-seller-payouts/mine',
      handler: 'processed-seller-payouts.mine',
      config: { auth: { scope: [] } },
    },
  ],
};
