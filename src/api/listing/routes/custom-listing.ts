export default {
  routes: [
    {
      method: 'POST',
      path: '/listings/:id/rocket/activate',
      handler: 'listing.activateRocket',
      config: { auth: { scope: [] } },
    },
    // LISTING_L19_MARKETPLACE_PRODUCT_GAP_FOUNDATIONS_REPORT.md L19.35:
    // public read-only discovery route, same auth shape as
    // find/findOne (granted via src/index.ts's Public role, not this
    // route's own config) -- listing.ts's similar() action re-applies
    // the same pending/rejected visibility gate findOne() already does.
    {
      method: 'GET',
      path: '/listings/:id/similar',
      handler: 'listing.similar',
      config: { auth: false },
    },
  ],
};
