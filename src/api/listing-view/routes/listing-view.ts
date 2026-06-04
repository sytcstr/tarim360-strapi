/**
 * listing-view router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::listing-view.listing-view' as any, {
  config: {
    create: {
      auth: false,
    },
  },
});
