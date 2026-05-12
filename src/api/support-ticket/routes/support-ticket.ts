/**
 * support-ticket router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter(
  'api::support-ticket.support-ticket' as any,
  {
    config: {
      find: {
        policies: ['global::support-ticket-ownership'],
      },
      findOne: {
        policies: ['global::support-ticket-ownership'],
      },
      create: {
        policies: ['global::support-ticket-ownership'],
      },
      update: {
        policies: ['global::support-ticket-ownership'],
      },
      delete: {
        policies: ['global::support-ticket-ownership'],
      },
    },
  },
);
