import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::logistics-load.logistics-load' as any, {
  config: {
    create: {
      auth: true,
      policies: ['api::logistics-load.require-logistics-premium'],
    },
    update: { auth: true },
    delete: { auth: true },
  },
} as any);
