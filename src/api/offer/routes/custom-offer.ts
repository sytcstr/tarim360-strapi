export default {
  routes: [
    {
      method: 'PATCH',
      path: '/offers/:offerId/seen',
      handler: 'offer.markSeen',
      config: { auth: { scope: [] } },
    },
  ],
};
