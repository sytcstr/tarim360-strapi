import { factories } from '@strapi/strapi';

const UID = 'api::ad-event.ad-event';
const AD_UID = 'api::ad.ad';

const asString = (value: unknown): string => String(value ?? '').trim();

const findAd = async (strapi: any, rawId: unknown) => {
  const id = asString(rawId);
  if (!id) return null;
  const numeric = Number(id.replace(/^strapi_/, ''));
  if (Number.isInteger(numeric) && numeric > 0) {
    try {
      const row = await strapi.entityService.findOne(AD_UID as any, numeric as any, {
        fields: ['id', 'documentId', 'impressions', 'showCount', 'displayCount', 'viewCount'],
      });
      if (row) return row;
    } catch (_) {
      // continue
    }
  }
  try {
    return strapi.db.query(AD_UID).findOne({ where: { documentId: id } } as any);
  } catch (_) {
    return null;
  }
};

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
        eventType: asString(data.eventType) || 'impression',
        createdAtClient: asString(data.createdAtClient) || new Date().toISOString(),
      },
    });

    try {
      const ad = await findAd(strapi, adId);
      if (ad?.id) {
        const impressions = Math.max(0, Number(ad.impressions ?? 0) || 0) + 1;
        const showCount = Math.max(0, Number(ad.showCount ?? 0) || 0) + 1;
        const displayCount = Math.max(0, Number(ad.displayCount ?? 0) || 0) + 1;
        const viewCount = Math.max(0, Number(ad.viewCount ?? 0) || 0) + 1;
        await strapi.entityService.update(AD_UID as any, ad.id, {
          data: { impressions, showCount, displayCount, viewCount } as any,
        });
      }
    } catch (e) {
      strapi.log.warn(`Ad event counter update failed: ${String(e)}`);
    }

    ctx.body = { data: entity };
  },
}));
