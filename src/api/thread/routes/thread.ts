/**
 * thread router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::thread.thread', {
  config: {
    find: {
      policies: ['global::thread-ownership'],
    },
    findOne: {
      policies: ['global::thread-ownership'],
    },
    create: {
      policies: ['global::thread-ownership'],
    },
    update: {
      policies: ['global::thread-ownership'],
    },
    delete: {
      policies: ['global::thread-ownership'],
    },
  },
});
