import { factories } from '@strapi/strapi';

const OFFER_UID = 'api::logistics-offer.logistics-offer';
const LOAD_UID = 'api::logistics-load.logistics-load';

const asString = (value: unknown): string => String(value ?? '').trim();
const asNumberId = (value: string): number | null => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};
const toLimit = (value: unknown, fallback = 200): number => {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(raw)));
};

const findEntityById = async (strapi: any, uid: string, rawId: string) => {
  const id = asString(rawId);
  if (!id) return null;
  const numeric = asNumberId(id);
  if (numeric) {
    try {
      const row = await strapi.entityService.findOne(uid as any, numeric as any);
      if (row) return row;
    } catch (_) {}
  }
  return strapi.db.query(uid).findOne({
    where: { documentId: id },
  } as any);
};

const updateLoadStatus = async (strapi: any, loadId: string, status: string) => {
  const load = await findEntityById(strapi, LOAD_UID, loadId);
  const numeric = Number((load as any)?.id ?? 0);
  if (!Number.isInteger(numeric) || numeric <= 0) return;
  await strapi.entityService.update(LOAD_UID as any, numeric as any, {
    data: { status },
  });
};

export default factories.createCoreController(OFFER_UID as any, ({ strapi }) => ({
  async byLoad(ctx) {
    const loadId = asString(ctx.params?.id);
    if (!loadId) return ctx.badRequest('loadId required.');
    const limit = toLimit(ctx.query?.limit, 200);

    const rows = await strapi.entityService.findMany(OFFER_UID as any, {
      filters: { loadId },
      sort: [{ price: 'asc' }, { createdAt: 'desc' }],
      pagination: { limit },
    } as any);

    ctx.body = { data: rows };
  },

  async accept(ctx) {
    const id = asString(ctx.params?.id);
    const offer = await findEntityById(strapi, OFFER_UID, id);
    const numeric = Number((offer as any)?.id ?? 0);
    if (!Number.isInteger(numeric) || numeric <= 0) return ctx.notFound('Offer not found.');

    const updated = await strapi.entityService.update(OFFER_UID as any, numeric as any, {
      data: {
        status: 'accepted',
        meetingStatus: 'meeting_opened',
      },
    });

    const loadId = asString((offer as any)?.loadId);
    if (loadId) await updateLoadStatus(strapi, loadId, 'meeting_opened');

    ctx.body = { data: updated };
  },

  async reject(ctx) {
    const id = asString(ctx.params?.id);
    const offer = await findEntityById(strapi, OFFER_UID, id);
    const numeric = Number((offer as any)?.id ?? 0);
    if (!Number.isInteger(numeric) || numeric <= 0) return ctx.notFound('Offer not found.');

    const updated = await strapi.entityService.update(OFFER_UID as any, numeric as any, {
      data: { status: 'rejected' },
    });

    ctx.body = { data: updated };
  },
}));

