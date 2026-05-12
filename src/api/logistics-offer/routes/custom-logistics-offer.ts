export default {
  routes: [
    {
      method: 'GET',
      path: '/logistics-offers/load/:id',
      handler: 'logistics-offer.byLoad',
      config: { auth: false },
    },
    {
      method: 'PUT',
      path: '/logistics-offers/:id/accept',
      handler: 'logistics-offer.accept',
      config: { auth: { scope: [] } },
    },
    {
      method: 'PUT',
      path: '/logistics-offers/:id/reject',
      handler: 'logistics-offer.reject',
      config: { auth: { scope: [] } },
    },
  ],
};
