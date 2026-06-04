import { factories } from '@strapi/strapi';

const UID = 'api::listing-view.listing-view';
const LISTING_UID = 'api::listing.listing';

const asString = (value: unknown): string => String(value ?? '').trim();

const listingCandidates = (raw: unknown): string[] => {
  const id = asString(raw);
  if (!id) return [];
  const set = new Set<string>([id]);
  for (const prefix of ['strapi_', 'listing_']) {
    if (id.startsWith(prefix)) {
      const trimmed = id.slice(prefix.length).trim();
      if (trimmed) set.add(trimmed);
    }
  }
  const digit = id.match(/(\d+)/)?.[1];
  if (digit) set.add(digit);
  return [...set];
};

const findListing = async (strapi: any, rawId: unknown) => {
  for (const id of listingCandidates(rawId)) {
    const numeric = Number(id);
    if (Number.isInteger(numeric) && numeric > 0) {
      try {
        const row = await strapi.entityService.findOne(LISTING_UID as any, numeric as any, {
          fields: ['id', 'documentId', 'listingNo', 'viewCount'],
        });
        if (row) return row;
      } catch (_) {
        // continue
      }
    }
    try {
      const row = await strapi.db.query(LISTING_UID).findOne({
        where: { documentId: id },
      } as any);
      if (row) return row;
    } catch (_) {
      // continue
    }
    if (Number.isInteger(numeric) && numeric > 0) {
      try {
        const row = await strapi.db.query(LISTING_UID).findOne({
          where: { listingNo: numeric },
        } as any);
        if (row) return row;
      } catch (_) {
        // continue
      }
    }
  }
  return null;
};

export default factories.createCoreController(UID as any, ({ strapi }) => ({
  async create(ctx) {
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const data = (body.data && typeof body.data === 'object' ? body.data : body) as Record<
      string,
      unknown
    >;
    const listingId = asString(data.listingId);
    if (!listingId) return ctx.badRequest('listingId zorunlu.');
    const viewedAt = asString(data.viewedAt) || new Date().toISOString();

    const entity = await strapi.entityService.create(UID as any, {
      data: {
        ...data,
        listingId,
        viewedAt,
      },
    });

    try {
      const listing = await findListing(strapi, listingId);
      if (listing?.id) {
        const current = Math.max(0, Number(listing.viewCount ?? 0) || 0);
        await strapi.entityService.update(LISTING_UID as any, listing.id, {
          data: { viewCount: current + 1 } as any,
        });
      }
    } catch (e) {
      strapi.log.warn(`Listing view counter update failed: ${String(e)}`);
    }

    ctx.body = { data: entity };
  },
}));
