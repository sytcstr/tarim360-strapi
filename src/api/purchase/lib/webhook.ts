import { asString, parseBool } from './catalog';

const WEBHOOK_ALLOW_NO_SECRET = parseBool(
  process.env.PURCHASE_WEBHOOK_ALLOW_NO_SECRET,
  false,
);

const PURCHASE_WEBHOOK_SECRET = asString(process.env.PURCHASE_WEBHOOK_SECRET);
export const GOOGLE_WEBHOOK_SECRET =
  asString(process.env.GOOGLE_PLAY_WEBHOOK_SECRET) || PURCHASE_WEBHOOK_SECRET;
export const APPLE_WEBHOOK_SECRET =
  asString(process.env.APPLE_WEBHOOK_SECRET) || PURCHASE_WEBHOOK_SECRET;

export const verifyWebhookSecret = (
  ctx: any,
  expectedSecret: string,
): { ok: boolean; message?: string } => {
  if (!expectedSecret) {
    if (WEBHOOK_ALLOW_NO_SECRET) return { ok: true };
    return {
      ok: false,
      message:
        'Webhook secret tanımlı değil. PURCHASE_WEBHOOK_SECRET veya provider secret ayarla.',
    };
  }

  const headerSecret = asString(ctx.request?.headers?.['x-webhook-secret']);
  const auth = asString(ctx.request?.headers?.authorization);
  const bearer = auth.toLowerCase().startsWith('bearer ')
    ? auth.slice(7).trim()
    : '';
  const candidate = headerSecret || bearer;
  if (!candidate || candidate !== expectedSecret) {
    return { ok: false, message: 'Webhook secret geçersiz.' };
  }
  return { ok: true };
};
