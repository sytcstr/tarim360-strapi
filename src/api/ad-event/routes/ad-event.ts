/**
 * ad-event router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::ad-event.ad-event' as any, {
  config: {
    create: {
      auth: false,
    },
  },
});
