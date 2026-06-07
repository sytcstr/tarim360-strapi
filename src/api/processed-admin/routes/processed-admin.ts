export default {
  routes: [
    {
      method: 'GET',
      path: '/processed-admin/access',
      handler: 'processed-admin.access',
      config: { auth: { scope: [] } },
    },
    {
      method: 'GET',
      path: '/processed-admin/stores',
      handler: 'processed-admin.stores',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/processed-admin/store-review',
      handler: 'processed-admin.storeReview',
      config: { auth: { scope: [] } },
    },
    {
      method: 'GET',
      path: '/processed-admin/products',
      handler: 'processed-admin.products',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/processed-admin/product-review',
      handler: 'processed-admin.productReview',
      config: { auth: { scope: [] } },
    },
  ],
};
