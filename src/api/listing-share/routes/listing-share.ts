/**
 * listing-share router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter(
  'api::listing-share.listing-share' as any,
  {
    config: {
      // ENGAGEMENT_API_CONTRACT.md §4.5: auth now required — was
      // previously `auth: false` with optional identity, letting an
      // anonymous caller spam real, publicly-visible shareCount rows.
      create: {
        auth: { scope: [] },
      },
    },
  },
);
