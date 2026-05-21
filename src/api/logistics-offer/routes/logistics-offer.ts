import { factories } from '@strapi/strapi';

export default factories.createCoreRouter('api::logistics-offer.logistics-offer' as any, {
  config: {
    create: { auth: { scope: [] } },
    update: { auth: { scope: [] } },
    delete: { auth: { scope: [] } },
  },
} as any);

