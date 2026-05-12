export default {
  routes: [
    {
      method: 'GET',
      path: '/processed-seller-stores/mine',
      handler: 'processed-seller-stores.mine',
      config: { auth: { scope: [] } },
    },
    {
      method: 'GET',
      path: '/processed-seller-stores/public',
      handler: 'processed-seller-stores.publicList',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/processed-seller-stores/upsert',
      handler: 'processed-seller-stores.upsert',
      config: { auth: { scope: [] } },
    },
  ],
};
