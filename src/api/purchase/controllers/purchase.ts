import crypto from 'crypto';
import type { Core } from '@strapi/strapi';
import {
  ALL_PRODUCTS,
  asString,
  normalizeProvider,
  parseJwtPayload,
  statusFromAppleNotificationType,
  statusFromGoogleNotificationType,
} from '../lib/catalog';
import { verifyWithProvider } from '../lib/providers';
import { findPurchaseEvent, upsertProfilePurchase, upsertPurchaseEvent } from '../lib/persistence';
import {
  APPLE_WEBHOOK_SECRET,
  GOOGLE_WEBHOOK_SECRET,
  verifyWebhookSecret,
} from '../lib/webhook';
import { readIdentity } from '../../../utils/identity';

const eventDataForVerify = (input: {
  ownerEmail: string;
  ownerProfileId: string;
  provider: string;
  productId: string;
  categoryTitle: string;
  planTitle: string;
  priceTl: number;
  isSubscription: boolean;
  transactionId: string;
  originalTransactionId?: string;
  purchaseToken?: string;
  status: string;
  expiresAt?: string;
  payload?: unknown;
}) => ({
  ownerEmail: input.ownerEmail,
  ownerProfileId: input.ownerProfileId,
  provider: input.provider,
  productId: input.productId,
  categoryTitle: input.categoryTitle,
  planTitle: input.planTitle,
  priceTl: input.priceTl,
  isSubscription: input.isSubscription,
  transactionId: input.transactionId,
  originalTransactionId: input.originalTransactionId || null,
  purchaseToken: input.purchaseToken || null,
  status: input.status,
  verifiedAt: new Date().toISOString(),
  expiresAt: input.expiresAt || null,
  payload: input.payload ?? null,
  source: 'verify_api',
});

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async verify(ctx: any) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const productId = asString(body.productId);
    const categoryTitle = asString(body.categoryTitle) || 'Bilinmeyen Kategori';
    const planTitle = asString(body.planTitle) || 'Bilinmeyen Plan';
    const priceTl = Number(body.priceTl ?? 0) || 0;
    const isSubscription = Boolean(body.isSubscription);
    const provider = normalizeProvider(asString(body.platform));
    const receipt = asString(body.receipt);
    const purchaseToken =
      provider === 'google_play' ? asString(body.purchaseToken) || receipt : '';

    if (!productId) return ctx.badRequest('productId zorunlu.');
    if (!provider) return ctx.badRequest('platform zorunlu/gecersiz.');
    if (!ALL_PRODUCTS.has(productId)) return ctx.badRequest('Bilinmeyen urun id.');

    const fallbackTx = crypto
      .createHash('sha256')
      .update(`${provider}:${productId}:${receipt}`)
      .digest('hex')
      .slice(0, 24);
    const rawRequestedTx = asString(body.transactionId);
    const requestedTx =
      rawRequestedTx &&
      rawRequestedTx !== receipt &&
      Buffer.byteLength(rawRequestedTx, 'utf8') <= 191
        ? rawRequestedTx
        : '';
    const transactionId = requestedTx || `${provider}_${productId}_${fallbackTx}`;

    const existing = await findPurchaseEvent(strapi, { transactionId });
    if (existing) {
      const eventOwnerId = asString(existing.ownerProfileId);
      if (eventOwnerId && eventOwnerId !== identity.ownerId) {
        return ctx.forbidden('Bu transaction farkli bir hesaba ait.');
      }
      if (asString(existing.status).toLowerCase() === 'verified') {
        ctx.body = {
          verified: true,
          success: true,
          idempotent: true,
          provider,
          productId,
          transactionId,
          message: 'Islem daha once dogrulanmis.',
        };
        return;
      }
    }

    let verified;
    try {
      verified = await verifyWithProvider({
        provider,
        productId,
        receipt,
        purchaseToken,
        isSubscription,
        fallbackTransactionId: transactionId,
      });
    } catch (e) {
      strapi.log.error(`Purchase verify exception: ${String(e)}`);
      return ctx.badRequest(`Dogrulama hatasi: ${String(e)}`);
    }
    const finalTx = asString(verified.transactionId) || transactionId;

    await upsertPurchaseEvent(
      strapi,
      eventDataForVerify({
        ownerEmail: identity.email,
        ownerProfileId: identity.ownerId,
        provider,
        productId,
        categoryTitle,
        planTitle,
        priceTl,
        isSubscription,
        transactionId: finalTx,
        originalTransactionId: asString(verified.originalTransactionId) || undefined,
        purchaseToken: asString(verified.purchaseToken) || purchaseToken || undefined,
        status: verified.status,
        expiresAt: asString(verified.expiresAt) || undefined,
        payload: verified.payload,
      }),
    );

    if (verified.verified) {
      await upsertProfilePurchase(strapi, {
        ownerId: identity.ownerId,
        categoryTitle,
        planTitle,
        priceTl,
        provider,
        transactionId: finalTx,
        productId,
        premiumEndsAt: asString(verified.expiresAt) || undefined,
        forcePremiumStatus: verified.status,
      });
    }

    ctx.body = {
      verified: verified.verified,
      success: verified.verified,
      provider,
      productId,
      transactionId: finalTx,
      originalTransactionId: asString(verified.originalTransactionId) || null,
      status: verified.status,
      expiresAt: asString(verified.expiresAt) || null,
      message: verified.message,
    };
  },

  async googleWebhook(ctx: any) {
    const sec = verifyWebhookSecret(ctx, GOOGLE_WEBHOOK_SECRET);
    if (!sec.ok) return ctx.unauthorized(sec.message || 'Unauthorized');

    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const message = (body.message ?? {}) as Record<string, unknown>;
    const rawData = asString(message.data);
    if (!rawData) return (ctx.body = { ok: true, skipped: true, reason: 'message.data yok' });

    const payload = JSON.parse(Buffer.from(rawData, 'base64').toString('utf8')) as Record<
      string,
      unknown
    >;
    const sub = (payload.subscriptionNotification ?? {}) as Record<string, unknown>;
    const purchaseToken = asString(sub.purchaseToken);
    const typeNo = Number(sub.notificationType ?? -1);
    if (!purchaseToken) return (ctx.body = { ok: true, skipped: true, reason: 'purchaseToken yok' });

    const existing = await findPurchaseEvent(strapi, { purchaseToken });
    if (!existing) return (ctx.body = { ok: true, skipped: true, reason: 'event bulunamadi' });

    const status = statusFromGoogleNotificationType(typeNo);
    const tx = asString(existing.transactionId);
    await upsertPurchaseEvent(strapi, {
      ...existing,
      status,
      source: 'google_webhook',
      payload: {
        ...(typeof existing.payload === 'object' && existing.payload
          ? (existing.payload as Record<string, unknown>)
          : {}),
        googleWebhook: payload,
      },
      verifiedAt: new Date().toISOString(),
      transactionId: tx,
    });
    await upsertProfilePurchase(strapi, {
      ownerId: asString(existing.ownerProfileId),
      categoryTitle: asString(existing.categoryTitle),
      planTitle: asString(existing.planTitle),
      priceTl: Number(existing.priceTl ?? 0) || 0,
      provider: 'google_play',
      transactionId: tx,
      productId: asString(existing.productId),
      premiumEndsAt: asString(existing.expiresAt) || undefined,
      forcePremiumStatus: status,
    });
    ctx.body = { ok: true, status, transactionId: tx };
  },

  async appleWebhook(ctx: any) {
    const sec = verifyWebhookSecret(ctx, APPLE_WEBHOOK_SECRET);
    if (!sec.ok) return ctx.unauthorized(sec.message || 'Unauthorized');

    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const signedPayload = asString(body.signedPayload);
    const decoded = signedPayload ? parseJwtPayload(signedPayload) : null;
    const notificationType = asString(decoded?.notificationType ?? body.notificationType);
    const data = (decoded?.data ?? body.data ?? {}) as Record<string, unknown>;
    const signedTx = asString(data.signedTransactionInfo);
    const txPayload = signedTx ? parseJwtPayload(signedTx) : null;
    const transactionId = asString(txPayload?.transactionId ?? body.transactionId);
    const originalTransactionId = asString(
      txPayload?.originalTransactionId ?? body.originalTransactionId,
    );

    const existing =
      (transactionId ? await findPurchaseEvent(strapi, { transactionId }) : null) ||
      (originalTransactionId
        ? await findPurchaseEvent(strapi, { originalTransactionId })
        : null);
    if (!existing) {
      return (ctx.body = { ok: true, skipped: true, reason: 'event bulunamadi' });
    }

    const status = statusFromAppleNotificationType(notificationType);
    const tx = asString(existing.transactionId);
    await upsertPurchaseEvent(strapi, {
      ...existing,
      status,
      source: 'apple_webhook',
      payload: {
        ...(typeof existing.payload === 'object' && existing.payload
          ? (existing.payload as Record<string, unknown>)
          : {}),
        appleWebhook: decoded || body,
      },
      verifiedAt: new Date().toISOString(),
      transactionId: tx,
    });
    await upsertProfilePurchase(strapi, {
      ownerId: asString(existing.ownerProfileId),
      categoryTitle: asString(existing.categoryTitle),
      planTitle: asString(existing.planTitle),
      priceTl: Number(existing.priceTl ?? 0) || 0,
      provider: 'app_store',
      transactionId: tx,
      productId: asString(existing.productId),
      premiumEndsAt: asString(existing.expiresAt) || undefined,
      forcePremiumStatus: status,
    });
    ctx.body = { ok: true, status, transactionId: tx };
  },
});
