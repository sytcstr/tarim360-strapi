/**
 * ad-click router
 */

import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::ad-click.ad-click' as any, {
  config: {
    create: {
      auth: false,
    },
  },
});
