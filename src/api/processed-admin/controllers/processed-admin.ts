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
  async access(ctx: any) {
    const authUserId = Number(ctx.state?.user?.id ?? 0);
    if (!authUserId) return ctx.unauthorized('Oturum gerekli.');

    try {
      const result = await strapi
        .service('api::processed-admin.processed-admin')
        .getAccess({ authUserId });
      ctx.body = { ok: true, ...result };
    } catch (error) {
      strapi.log.error(`Processed admin access failed: ${String(error)}`);
      return sendError(ctx, error, 'Admin erisimi dogrulanamadi.');
    }
  },

  async stores(ctx: any) {
    const authUserId = Number(ctx.state?.user?.id ?? 0);
    if (!authUserId) return ctx.unauthorized('Oturum gerekli.');

    try {
      const stores = await strapi
        .service('api::processed-admin.processed-admin')
        .listStores({ authUserId });
      ctx.body = { ok: true, stores };
    } catch (error) {
      strapi.log.error(`Processed admin stores failed: ${String(error)}`);
      return sendError(ctx, error, 'Magaza listesi alinamadi.');
    }
  },

  async storeReview(ctx: any) {
    const authUserId = Number(ctx.state?.user?.id ?? 0);
    if (!authUserId) return ctx.unauthorized('Oturum gerekli.');

    try {
      const store = await strapi
        .service('api::processed-admin.processed-admin')
        .reviewStore({ authUserId, body: ctx.request?.body ?? {} });
      ctx.body = { ok: true, store };
    } catch (error) {
      strapi.log.error(`Processed admin store review failed: ${String(error)}`);
      return sendError(ctx, error, 'Magaza onayi guncellenemedi.');
    }
  },

  async products(ctx: any) {
    const authUserId = Number(ctx.state?.user?.id ?? 0);
    if (!authUserId) return ctx.unauthorized('Oturum gerekli.');

    try {
      const products = await strapi
        .service('api::processed-admin.processed-admin')
        .listProducts({ authUserId });
      ctx.body = { ok: true, products };
    } catch (error) {
      strapi.log.error(`Processed admin products failed: ${String(error)}`);
      return sendError(ctx, error, 'Urun listesi alinamadi.');
    }
  },

  async productReview(ctx: any) {
    const authUserId = Number(ctx.state?.user?.id ?? 0);
    if (!authUserId) return ctx.unauthorized('Oturum gerekli.');

    try {
      const product = await strapi
        .service('api::processed-admin.processed-admin')
        .reviewProduct({ authUserId, body: ctx.request?.body ?? {} });
      ctx.body = { ok: true, product };
    } catch (error) {
      strapi.log.error(`Processed admin product review failed: ${String(error)}`);
      return sendError(ctx, error, 'Urun denetimi guncellenemedi.');
    }
  },

  async commissions(ctx: any) {
    const authUserId = Number(ctx.state?.user?.id ?? 0);
    if (!authUserId) return ctx.unauthorized('Oturum gerekli.');

    try {
      const commissions = await strapi
        .service('api::processed-admin.processed-admin')
        .listCommissions({ authUserId });
      ctx.body = { ok: true, commissions };
    } catch (error) {
      strapi.log.error(`Processed admin commissions failed: ${String(error)}`);
      return sendError(ctx, error, 'Komisyon kayitlari alinamadi.');
    }
  },

  async orders(ctx: any) {
    const authUserId = Number(ctx.state?.user?.id ?? 0);
    if (!authUserId) return ctx.unauthorized('Oturum gerekli.');

    try {
      const orders = await strapi
        .service('api::processed-admin.processed-admin')
        .listOrders({ authUserId });
      ctx.body = { ok: true, orders };
    } catch (error) {
      strapi.log.error(`Processed admin orders failed: ${String(error)}`);
      return sendError(ctx, error, 'Siparis listesi alinamadi.');
    }
  },

  async orderIssue(ctx: any) {
    const authUserId = Number(ctx.state?.user?.id ?? 0);
    if (!authUserId) return ctx.unauthorized('Oturum gerekli.');

    try {
      const order = await strapi
        .service('api::processed-admin.processed-admin')
        .updateOrderIssue({ authUserId, body: ctx.request?.body ?? {} });
      ctx.body = { ok: true, order };
    } catch (error) {
      strapi.log.error(`Processed admin order issue failed: ${String(error)}`);
      return sendError(ctx, error, 'Siparis issue bilgisi guncellenemedi.');
    }
  },
});
