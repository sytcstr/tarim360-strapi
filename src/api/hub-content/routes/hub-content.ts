/**
 * hub-content router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::hub-content.hub-content', {
  config: {
    create: {
      policies: ['global::hub-content-write-guard'],
    },
    update: {
      policies: ['global::hub-content-write-guard'],
    },
    delete: {
      policies: ['global::hub-content-write-guard'],
    },
  },
});
