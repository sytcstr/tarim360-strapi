/**
 * support-ticket-message router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter(
  'api::support-ticket-message.support-ticket-message' as any,
  {
    config: {
      find: {
        policies: ['global::support-ticket-message-ownership'],
      },
      findOne: {
        policies: ['global::support-ticket-message-ownership'],
      },
      create: {
        policies: ['global::support-ticket-message-ownership'],
      },
      update: {
        policies: ['global::support-ticket-message-ownership'],
      },
      delete: {
        policies: ['global::support-ticket-message-ownership'],
      },
    },
  },
);
