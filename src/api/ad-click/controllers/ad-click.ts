import { factories } from '@strapi/strapi';

const UID = 'api::ad-click.ad-click';

const asString = (value: unknown): string => String(value ?? '').trim();

export default factories.createCoreController(UID as any, ({ strapi }) => ({
  async create(ctx) {
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const data = (body.data && typeof body.data === 'object' ? body.data : body) as Record<
      string,
      unknown
    >;
    const adId = asString(data.adId);
    if (!adId) return ctx.badRequest('adId zorunlu.');
    const entity = await strapi.entityService.create(UID as any, {
      data: {
        ...data,
        adId,
        eventType: 'click',
        createdAtClient: asString(data.createdAtClient) || new Date().toISOString(),
      },
    });

    ctx.body = { data: entity };
  },
}));
