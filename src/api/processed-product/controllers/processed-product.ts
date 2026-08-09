import { factories } from '@strapi/strapi';
import { readIdentity } from '../../../utils/identity';

const PRODUCT_UID = 'api::processed-product.processed-product';

/**
 * Faz D5-B: likeCount/favoriteCount/viewCount (and the legacy aliases
 * likes/favorites/views the pre-D5-B Flutter client still sends — see
 * ProcessedProductInsightsStore._syncProductMetrics) must never be
 * settable through the generic create/update actions. engagement_
 * interactions (via setMembership/registerView) is the only real source
 * of truth for these fields now; a client-supplied absolute value here
 * would silently desync the counter from the real interaction count.
 * engagementVersion is likewise server-only.
 */
const ENGAGEMENT_ONLY_FIELDS = [
  'likeCount',
  'favoriteCount',
  'viewCount',
  'engagementVersion',
  'likes',
  'favorites',
  'views',
];

const stripEngagementFields = (data: Record<string, any>): Record<string, any> => {
  const next = { ...data };
  for (const field of ENGAGEMENT_ONLY_FIELDS) delete next[field];
  return next;
};

const toMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return fallback;
};

const toStatusCode = (error: unknown, fallback = 500) => {
  const raw = Number((error as any)?.statusCode ?? fallback);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
};

const sendError = (ctx: any, error: unknown, fallback: string) => {
  const code = toStatusCode(error);
  const message = toMessage(error, fallback);

  if (code === 400) return ctx.badRequest(message);
  if (code === 401) return ctx.unauthorized(message);
  if (code === 403) return ctx.forbidden(message);
  if (code === 404) return ctx.notFound(message);

  ctx.status = 500;
  ctx.body = { ok: false, error: { message } };
};

export default factories.createCoreController(PRODUCT_UID as any, ({ strapi }) => ({
  async create(ctx: any) {
    const body = (ctx.request?.body ?? {}) as Record<string, any>;
    const input = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, any>;
    ctx.request.body = { data: stripEngagementFields(input) };
    return super.create(ctx);
  },

  async update(ctx: any) {
    const body = (ctx.request?.body ?? {}) as Record<string, any>;
    const input = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, any>;
    ctx.request.body = { data: stripEngagementFields(input) };
    return super.update(ctx);
  },

  async mine(ctx: any) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

    try {
      const products = await strapi
        .service('api::processed-products.processed-products')
        .getMine({ identity });
      ctx.body = { ok: true, products };
    } catch (error) {
      strapi.log.error(`Processed products mine failed: ${String(error)}`);
      return sendError(ctx, error, 'Urunler alinamadi.');
    }
  },

  async publicList(ctx: any) {
    try {
      const products = await strapi
        .service('api::processed-products.processed-products')
        .listPublic();
      ctx.body = { ok: true, products };
    } catch (error) {
      strapi.log.error(`Processed products public list failed: ${String(error)}`);
      return sendError(ctx, error, 'Urun listesi alinamadi.');
    }
  },
}));
