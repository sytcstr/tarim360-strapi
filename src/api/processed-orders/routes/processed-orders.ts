export default {
  routes: [
    {
      method: 'POST',
      path: '/processed-orders/create',
      handler: 'processed-orders.create',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/processed-orders/status',
      handler: 'processed-orders.status',
      config: { auth: { scope: [] } },
    },
  ],
};
