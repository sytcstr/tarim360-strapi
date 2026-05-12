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

  async upsert(ctx: any) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

    try {
      const product = await strapi
        .service('api::processed-products.processed-products')
        .upsert({
          body: ctx.request?.body ?? {},
          identity,
        });
      ctx.body = { ok: true, product };
    } catch (error) {
      strapi.log.error(`Processed product upsert failed: ${String(error)}`);
      return sendError(ctx, error, 'Urun kaydedilemedi.');
    }
  },

  async delete(ctx: any) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

    try {
      const result = await strapi
        .service('api::processed-products.processed-products')
        .deleteOwned({
          body: ctx.request?.body ?? {},
          identity,
        });
      ctx.body = { ok: true, deleted: result };
    } catch (error) {
      strapi.log.error(`Processed product delete failed: ${String(error)}`);
      return sendError(ctx, error, 'Urun silinemedi.');
    }
  },
});
