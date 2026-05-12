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
  ctx.body = {
    ok: false,
    error: {
      message,
    },
  };
};

export default ({ strapi }: { strapi: any }) => ({
  async create(ctx: any) {
    const authUserId = Number(ctx.state?.user?.id ?? 0);
    if (!authUserId) return ctx.unauthorized('Oturum gerekli.');

    try {
      const result = await strapi
        .service('api::processed-orders.processed-orders')
        .createOrderBundle({
          body: ctx.request?.body ?? {},
          authUserId,
        });

      const createdId = Number((result.order as any)?.id ?? 0);
      ctx.body = {
        ok: true,
        id: createdId,
        order: result.order,
        items: result.items,
        commissionRecords: result.commissionRecords,
      };
    } catch (error) {
      strapi.log.error(`Processed order create failed: ${String(error)}`);
      return sendError(ctx, error, 'Siparis olusturulamadi.');
    }
  },

  async status(ctx: any) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

    try {
      const result = await strapi
        .service('api::processed-orders.processed-orders')
        .updateOrderStatus({
          body: ctx.request?.body ?? {},
          identity,
        });

      ctx.body = {
        ok: true,
        order: result.order,
      };
    } catch (error) {
      strapi.log.error(`Processed order status update failed: ${String(error)}`);
      return sendError(ctx, error, 'Siparis durumu guncellenemedi.');
    }
  },
});
