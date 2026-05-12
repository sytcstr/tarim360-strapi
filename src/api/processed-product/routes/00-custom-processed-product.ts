export default {
  routes: [
    {
      method: 'GET',
      path: '/processed-products/mine',
      handler: 'processed-product.mine',
      config: { auth: { scope: [] } },
    },
    {
      method: 'GET',
      path: '/processed-products/public',
      handler: 'processed-product.publicList',
      config: { auth: false },
    },
  ],
};
