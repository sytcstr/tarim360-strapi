export default {
  routes: [
    {
      method: 'POST',
      path: '/purchases/verify',
      handler: 'purchase.verify',
      config: { auth: { scope: [] } },
    },
    {
      method: 'POST',
      path: '/purchases/webhooks/google-play',
      handler: 'purchase.googleWebhook',
      config: { auth: false },
    },
    {
      method: 'POST',
      path: '/purchases/webhooks/apple',
      handler: 'purchase.appleWebhook',
      config: { auth: false },
    },
  ],
};
