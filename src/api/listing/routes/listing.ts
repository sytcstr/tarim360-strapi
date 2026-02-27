/**
 * listing router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::listing.listing', {
  config: {
    create: {
      policies: ['global::listing-owner-write'],
    },
    update: {
      policies: ['global::listing-owner-write'],
    },
    delete: {
      policies: ['global::listing-owner-write'],
    },
  },
});
