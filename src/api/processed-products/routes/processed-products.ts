export default {
  routes: [
    {
      method: 'GET',
      path: '/processed-products/mine',
      handler: 'processed-products.mine',
      config: { auth: { scope: [] } },
    },
    {
      method: 'GET',
      path: '/processed-products/public',
      handler: 'processed-products.publicList',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/processed-products/upsert',
      handler: 'processed-products.upsert',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/processed-products/delete',
      handler: 'processed-products.delete',
      config: { auth: { scope: [] } },
    },
  ],
};
