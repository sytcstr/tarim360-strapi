/**
 * message router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::message.message', {
  config: {
    find: {
      policies: ['global::message-ownership'],
    },
    findOne: {
      policies: ['global::message-ownership'],
    },
    create: {
      policies: ['global::message-ownership'],
    },
    update: {
      policies: ['global::message-ownership'],
    },
    delete: {
      policies: ['global::message-ownership'],
    },
  },
});
