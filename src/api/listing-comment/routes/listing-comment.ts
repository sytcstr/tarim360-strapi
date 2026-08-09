/**
 * listing-comment router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter(
  'api::listing-comment.listing-comment' as any,
  {
    config: {
      create: {
        auth: { scope: [] },
      },
      delete: {
        auth: { scope: [] },
      },
    },
  },
);
