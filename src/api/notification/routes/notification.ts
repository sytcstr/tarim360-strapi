/**
 * notification router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::notification.notification', {
  config: {
    find: {
      policies: ['global::notification-ownership'],
    },
    findOne: {
      policies: ['global::notification-ownership'],
    },
    create: {
      policies: ['global::notification-ownership'],
    },
    update: {
      policies: ['global::notification-ownership'],
    },
    delete: {
      policies: ['global::notification-ownership'],
    },
  },
});
