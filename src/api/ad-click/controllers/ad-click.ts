import { factories } from '@strapi/strapi';

const UID = 'api::ad-click.ad-click';
const AD_UID = 'api::ad.ad';

const asString = (value: unknown): string => String(value ?? '').trim();

const findAd = async (strapi: any, rawId: unknown) => {
  const id = asString(rawId);
  if (!id) return null;
  const numeric = Number(id.replace(/^strapi_/, ''));
  if (Number.isInteger(numeric) && numeric > 0) {
    try {
      const row = await strapi.entityService.findOne(AD_UID as any, numeric as any, {
        fields: ['id', 'documentId', 'likeCount'],
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
        eventType: 'click',
        createdAtClient: asString(data.createdAtClient) || new Date().toISOString(),
      },
    });

    try {
      const ad = await findAd(strapi, adId);
      if (ad?.id) {
        const likeCount = Math.max(0, Number(ad.likeCount ?? 0) || 0) + 1;
        await strapi.entityService.update(AD_UID as any, ad.id, {
          data: { likeCount } as any,
        });
      }
    } catch (e) {
      strapi.log.warn(`Ad click counter update failed: ${String(e)}`);
    }

    ctx.body = { data: entity };
  },
}));
