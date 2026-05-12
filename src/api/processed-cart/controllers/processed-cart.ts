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
    const authUserId = Number(ctx.state?.user?.id ?? 0);
    if (!identity || !authUserId) return ctx.unauthorized('Kimlik dogrulanamadi.');

    try {
      const cart = await strapi
        .service('api::processed-cart.processed-cart')
        .getMine({ authUserId, identity });
      ctx.body = { ok: true, cart, items: cart?.items ?? [] };
    } catch (error) {
      strapi.log.error(`Processed cart mine failed: ${String(error)}`);
      return sendError(ctx, error, 'Sepet alinamadi.');
    }
  },

  async sync(ctx: any) {
    const identity = readIdentity(ctx);
    const authUserId = Number(ctx.state?.user?.id ?? 0);
    if (!identity || !authUserId) return ctx.unauthorized('Kimlik dogrulanamadi.');

    try {
      const cart = await strapi
        .service('api::processed-cart.processed-cart')
        .syncCart({ authUserId, identity, body: ctx.request?.body ?? {} });
      ctx.body = { ok: true, cart, items: cart?.items ?? [] };
    } catch (error) {
      strapi.log.error(`Processed cart sync failed: ${String(error)}`);
      return sendError(ctx, error, 'Sepet senkronize edilemedi.');
    }
  },

  async clear(ctx: any) {
    const identity = readIdentity(ctx);
    const authUserId = Number(ctx.state?.user?.id ?? 0);
    if (!identity || !authUserId) return ctx.unauthorized('Kimlik dogrulanamadi.');

    try {
      const result = await strapi
        .service('api::processed-cart.processed-cart')
        .clearCart({ authUserId, identity, body: ctx.request?.body ?? {} });
      ctx.body = { ok: true, ...result };
    } catch (error) {
      strapi.log.error(`Processed cart clear failed: ${String(error)}`);
      return sendError(ctx, error, 'Sepet temizlenemedi.');
    }
  },
});
