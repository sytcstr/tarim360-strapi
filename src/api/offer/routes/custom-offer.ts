export default {
  routes: [
    {
      method: 'PATCH',
      path: '/offers/:offerId/seen',
      handler: 'offer.markSeen',
      config: { auth: { scope: [] } },
    },
    {
      method: 'PATCH',
      path: '/offers/:offerId/by-offer-id',
      handler: 'offer.updateByOfferId',
      config: { auth: { scope: [] } },
    },
    {
      method: 'DELETE',
      path: '/offers/:offerId/by-offer-id',
      handler: 'offer.deleteByOfferId',
      config: { auth: { scope: [] } },
    },
  ],
};
