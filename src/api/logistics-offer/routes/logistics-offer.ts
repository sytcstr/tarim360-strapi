import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::logistics-offer.logistics-offer' as any, {
  config: {
    create: { auth: true },
    update: { auth: true },
    delete: { auth: true },
  },
} as any);
