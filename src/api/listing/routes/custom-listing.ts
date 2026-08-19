export default {
  routes: [
    {
      method: 'POST',
      path: '/listings/:id/rocket/activate',
      handler: 'listing.activateRocket',
      config: { auth: { scope: [] } },
    },
  ],
};
