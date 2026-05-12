import {
  findActiveRegistrationBlock,
  normalizeEmail,
  normalizePhone,
  registrationUserMessage,
} from '../utils/registration-block';

const REGISTER_PATH = '/api/auth/local/register';

export default (_config: unknown, { strapi }: { strapi: any }) => {
  return async (ctx: any, next: () => Promise<void>) => {
    const method = String(ctx.request?.method ?? '').toUpperCase();
    const path = String(ctx.request?.path ?? '');

    if (method !== 'POST' || path !== REGISTER_PATH) {
      await next();
      return;
    }

    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const email = normalizeEmail(body.email);
    const phone = normalizePhone(body.phone);

    if (!email) {
      await next();
      return;
    }

    const match = await findActiveRegistrationBlock(strapi, { email, phone });
    if (!match) {
      await next();
      return;
    }

    ctx.status = 403;
    ctx.body = {
      error: {
        status: 403,
        name: 'RegistrationBlockedError',
        message: registrationUserMessage(match.userMessage),
        details: {
          reasonCode: match.reasonCode,
          matchedBy: match.matchedBy,
          blockId: match.id,
        },
      },
    };
  };
};
