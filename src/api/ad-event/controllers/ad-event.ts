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
        fields: ['id', 'documentId', 'showCount', 'displayCount', 'viewCount'],
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
    const eventType = asString(data.eventType) || 'impression';
    const entity = await strapi.entityService.create(UID as any, {
      data: {
        ...data,
        adId,
        eventType,
        createdAtClient: asString(data.createdAtClient) || new Date().toISOString(),
      },
    });

    /**
     * SEMANTIC_CONTRACT_S2 (audit 2.7): `impressions` is now exclusively
     * owned by Engagement v1's registerView (engagement-contract.ts's
     * VIEW_COUNT_FIELD.ad = 'impressions', 24h actor-dedup) -- this handler
     * used to bump it unconditionally on every ad-event regardless of
     * eventType. The only eventType any live Flutter caller actually sends
     * here is 'click' (ApprovedAdsStore.trackClick, deliberately kept
     * outside the engagement contract per main.dart's own comment at the
     * registerView/trackClick call site) -- meaning every real call to this
     * endpoint was double-counting one ad-detail-page open as two
     * impressions, AND counting a click itself as an impression. `likes`
     * is engagement-v1-owned too (COUNTER_FIELD.ad.like = 'likes') and was
     * never touched here, so no change needed for that field.
     *
     * Fix: never touch `impressions` here (Engagement v1's registerView is
     * the single authority). Only bump the legacy show/display/view
     * counters, and only for a genuine impression-shaped event -- a click
     * must not inflate any impression-labeled counter either.
     */
    if (eventType === 'impression') {
      try {
        const ad = await findAd(strapi, adId);
        if (ad?.id) {
          const showCount = Math.max(0, Number(ad.showCount ?? 0) || 0) + 1;
          const displayCount = Math.max(0, Number(ad.displayCount ?? 0) || 0) + 1;
          const viewCount = Math.max(0, Number(ad.viewCount ?? 0) || 0) + 1;
          await strapi.entityService.update(AD_UID as any, ad.id, {
            data: { showCount, displayCount, viewCount } as any,
          });
        }
      } catch (e) {
        strapi.log.warn(`Ad event counter update failed: ${String(e)}`);
      }
    }

    ctx.body = { data: entity };
  },
}));
