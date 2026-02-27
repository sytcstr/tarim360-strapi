/**
 * ad router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::ad.ad', {
  config: {
    create: {
      policies: ['global::ad-owner-write'],
    },
    update: {
      policies: ['global::ad-owner-write'],
    },
    delete: {
      policies: ['global::ad-owner-write'],
    },
  },
});
