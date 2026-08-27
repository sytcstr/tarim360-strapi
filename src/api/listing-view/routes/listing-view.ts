/**
 * listing-view router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::listing-view.listing-view' as any, {
  config: {
    create: {
      auth: false,
      // LISTING_L9_OWNER_BUYER_ACTION_POLICY_REPORT.md L9.9: `auth: false`
      // alone skips Strapi's own JWT verification entirely (ctx.state.user
      // is never populated even with a valid Bearer token, the same
      // "confirmed via a real boot" finding engagement-v1's own route
      // config documents) -- without this, the controller's self-view
      // check (readIdentity(ctx)) could never see a real logged-in owner,
      // silently never firing. Reuses the exact same optional-auth
      // middleware /engagements/view already relies on, not a
      // reimplementation.
      middlewares: [{ name: 'global::engagement-soft-auth', config: {} }],
    },
  },
});
