import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::logistics-load.logistics-load' as any, {
  config: {
    create: {
      auth: { scope: [] },
      policies: ['global::require-logistics-premium'],
    },
    update: { auth: { scope: [] } },
    delete: { auth: { scope: [] } },
  },
} as any);


