import { factories } from '@strapi/strapi';
import { readIdentity } from '../../../utils/identity';

const OFFER_UID = 'api::logistics-offer.logistics-offer';
const LOAD_UID = 'api::logistics-load.logistics-load';
const createLocks = new Map<string, Promise<void>>();

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

const findByOfferId = async (strapi: any, offerId: string) =>
  strapi.db.query(OFFER_UID).findOne({
    where: { offerId },
  } as any);

const matchesTransporter = (
  entity: Record<string, unknown>,
  email: string,
  ownerId: string,
): boolean => {
  const raw = asString(entity.transporterKey).toLowerCase();
  const normalized = raw.replace(/^(id:|email:|username:)/, '').trim();
  return normalized === ownerId.toLowerCase() || normalized === email;
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

const updateLoadStatus = async (
  strapi: any,
  loadId: string,
  status: string,
) => {
  const load = await findEntityById(strapi, LOAD_UID, loadId);
  const numeric = Number((load as any)?.id ?? 0);
  if (!Number.isInteger(numeric) || numeric <= 0) return;
  await strapi.entityService.update(LOAD_UID as any, numeric as any, {
    data: { status },
  });
};

export default factories.createCoreController(
  OFFER_UID as any,
  ({ strapi }) => ({
    async create(ctx) {
      const identity = readIdentity(ctx);
      if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

      const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
      const payload = (body.data ?? body) as Record<string, unknown>;
      const data: Record<string, unknown> = { ...payload };
      const headerKey = asString(
        ctx.request?.headers?.['idempotency-key'],
      );
      const offerId = asString(data.offerId || headerKey);

      if (!offerId) return ctx.badRequest('offerId zorunludur.');

      const respondWithExisting = async (
        entity: Record<string, unknown>,
      ) => {
        if (
          !matchesTransporter(
            entity,
            identity.email,
            identity.ownerId,
          )
        ) {
          return ctx.conflict('Bu offerId baska bir teklifte kullaniliyor.');
        }
        const sanitized = await this.sanitizeOutput(entity, ctx);
        ctx.status = 200;
        ctx.body = this.transformResponse(sanitized, { idempotent: true });
      };

      const existing = await findByOfferId(strapi, offerId);
      if (existing) return respondWithExisting(existing);

      const activeCreate = createLocks.get(offerId);
      if (activeCreate) {
        await activeCreate;
        const created = await findByOfferId(strapi, offerId);
        if (!created) {
          return ctx.internalServerError('Teklif kaydi dogrulanamadi.');
        }
        return respondWithExisting(created);
      }

      data.offerId = offerId;
      data.transporterKey = `id:${identity.ownerId}`;
      const creation = (async () => {
        const sanitizedInput = await this.sanitizeInput(data, ctx);
        return strapi.entityService.create(OFFER_UID as any, {
          data: sanitizedInput,
        });
      })();
      const completion = creation.then(
        () => undefined,
        () => undefined,
      );
      createLocks.set(offerId, completion);

      try {
        const entity = await creation;
        const sanitizedOutput = await this.sanitizeOutput(entity, ctx);
        ctx.status = 201;
        ctx.body = this.transformResponse(sanitizedOutput);
      } catch (error) {
        const createdByConcurrentRequest = await findByOfferId(
          strapi,
          offerId,
        );
        if (!createdByConcurrentRequest) throw error;
        return respondWithExisting(createdByConcurrentRequest);
      } finally {
        if (createLocks.get(offerId) === completion) {
          createLocks.delete(offerId);
        }
      }
    },

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
      if (!Number.isInteger(numeric) || numeric <= 0) {
        return ctx.notFound('Offer not found.');
      }

      const updated = await strapi.entityService.update(
        OFFER_UID as any,
        numeric as any,
        {
          data: {
            status: 'accepted',
            meetingStatus: 'meeting_opened',
          },
        },
      );

      const loadId = asString((offer as any)?.loadId);
      if (loadId) await updateLoadStatus(strapi, loadId, 'meeting_opened');

      ctx.body = { data: updated };
    },

    async reject(ctx) {
      const id = asString(ctx.params?.id);
      const offer = await findEntityById(strapi, OFFER_UID, id);
      const numeric = Number((offer as any)?.id ?? 0);
      if (!Number.isInteger(numeric) || numeric <= 0) {
        return ctx.notFound('Offer not found.');
      }

      const updated = await strapi.entityService.update(
        OFFER_UID as any,
        numeric as any,
        {
          data: { status: 'rejected' },
        },
      );

      ctx.body = { data: updated };
    },
  }),
);
