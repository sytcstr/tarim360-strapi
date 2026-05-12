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
      const documents = await strapi
        .service('api::processed-store-documents.processed-store-documents')
        .getMine({ identity });
      ctx.body = { ok: true, documents };
    } catch (error) {
      strapi.log.error(`Processed store documents mine failed: ${String(error)}`);
      return sendError(ctx, error, 'Belgeler alinamadi.');
    }
  },

  async create(ctx: any) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

    try {
      const document = await strapi
        .service('api::processed-store-documents.processed-store-documents')
        .createOwned({ body: ctx.request?.body ?? {}, identity });
      ctx.body = { ok: true, document };
    } catch (error) {
      strapi.log.error(`Processed store document create failed: ${String(error)}`);
      return sendError(ctx, error, 'Belge kaydedilemedi.');
    }
  },

  async delete(ctx: any) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

    try {
      const result = await strapi
        .service('api::processed-store-documents.processed-store-documents')
        .deleteOwned({ body: ctx.request?.body ?? {}, identity });
      ctx.body = { ok: true, deleted: result };
    } catch (error) {
      strapi.log.error(`Processed store document delete failed: ${String(error)}`);
      return sendError(ctx, error, 'Belge silinemedi.');
    }
  },
});
