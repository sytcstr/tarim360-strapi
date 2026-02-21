export default {
  routes: [
    {
      method: 'POST',
      path: '/purchases/verify',
      handler: 'purchase.verify',
      config: { auth: false },
    },
  ],
};
