/**
 * offer router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::offer.offer', {
  config: {
    find: {
      policies: ['global::offer-ownership'],
    },
    findOne: {
      policies: ['global::offer-ownership'],
    },
    create: {
      policies: ['global::offer-ownership'],
    },
    update: {
      policies: ['global::offer-ownership'],
    },
    delete: {
      policies: ['global::offer-ownership'],
    },
  },
});
