import { readIdentity } from '../../../utils/identity';

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

export default ({ strapi }: { strapi: any }) => ({
  async mine(ctx: any) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

    try {
      const store = await strapi
        .service('api::processed-seller-stores.processed-seller-stores')
        .getMine({ identity });
      ctx.body = { ok: true, store };
    } catch (error) {
      strapi.log.error(`Processed seller store mine failed: ${String(error)}`);
      return sendError(ctx, error, 'Magaza bilgisi alinamadi.');
    }
  },

  async publicList(ctx: any) {
    try {
      const stores = await strapi
        .service('api::processed-seller-stores.processed-seller-stores')
        .listPublic();
      ctx.body = { ok: true, stores };
    } catch (error) {
      strapi.log.error(`Processed seller store public list failed: ${String(error)}`);
      return sendError(ctx, error, 'Magaza listesi alinamadi.');
    }
  },

  async upsert(ctx: any) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

    try {
      const store = await strapi
        .service('api::processed-seller-stores.processed-seller-stores')
        .upsert({
          body: ctx.request?.body ?? {},
          identity,
        });
      ctx.body = { ok: true, store };
    } catch (error) {
      strapi.log.error(`Processed seller store upsert failed: ${String(error)}`);
      return sendError(ctx, error, 'Magaza kaydedilemedi.');
    }
  },
});
