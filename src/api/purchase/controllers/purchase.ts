import crypto from 'crypto';
import type { Core } from '@strapi/strapi';
import {
  ALL_PRODUCTS,
  asString,
  normalizeProvider,
  parseIso,
  PurchaseStatus,
} from '../lib/catalog';
import { appleConfig, googleConfig, isSoftVerifyRefused, trustedAppleRoots } from '../lib/config';
import { verifyAppleJws } from '../lib/apple-jws';
import { verifyPubSubOidc } from '../lib/google-oidc';
import { verifyGoogle, verifyWithProvider } from '../lib/providers';
import {
  findConflictingOwnerEvent,
  findPurchaseEvent,
  upsertProfilePurchase,
  upsertPurchaseEvent,
  withPurchaseIdentityLock,
} from '../lib/persistence';
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

const SMART_ADS_ENABLED = ['1', 'true', 'yes', 'on'].includes(
  asString(process.env.ENABLE_SMART_ADS).toLowerCase(),
);

const isExpired = (iso: unknown): boolean => {
  const d = parseIso(iso);
  return !!d && d.getTime() <= Date.now();
};

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async verify(ctx: any) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

    if (isSoftVerifyRefused()) {
      strapi.log.error(
        'PURCHASE_VERIFY_SOFT is set outside development/test and is IGNORED: real store verification is always enforced.',
      );
    }

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
    if (productId.startsWith('smart_ads_') && !SMART_ADS_ENABLED) {
      return ctx.badRequest('Akilli reklam satin alimlari su anda kapali.');
    }

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

    // A client-supplied transaction id is only a lookup hint for retries; it is
    // never an ownership decision. The stored event must belong to the caller,
    // and a still-valid verified event is answered idempotently.
    const existing = await findPurchaseEvent(strapi, { transactionId });
    if (existing) {
      if (asString(existing.ownerProfileId) !== identity.ownerId) {
        return ctx.forbidden('Bu satin alma farkli bir hesaba ait.');
      }
      if (
        asString(existing.status).toLowerCase() === 'verified' &&
        !isExpired(existing.expiresAt)
      ) {
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

    // Cheap pre-check on what the store identity already is (Google token).
    if (purchaseToken) {
      const early = await findConflictingOwnerEvent(strapi, identity.ownerId, {
        purchaseTokens: [purchaseToken],
      });
      if (early) return ctx.forbidden('Bu satin alma farkli bir hesaba bagli.');
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
      return ctx.badRequest('Dogrulama su anda yapilamiyor.');
    }
    const finalTx = asString(verified.transactionId) || transactionId;
    const storeToken = asString(verified.purchaseToken) || purchaseToken;
    const storeOriginal = asString(verified.originalTransactionId);

    // Authoritative ownership: decided on the STORE's identity (provider
    // transaction id, purchase token, original transaction id), inside a lock so
    // two accounts racing on one purchase cannot both bind it.
    const outcome = await withPurchaseIdentityLock(
      [`tx:${finalTx}`, storeToken && `tok:${storeToken}`, storeOriginal && `orig:${storeOriginal}`].filter(
        Boolean,
      ) as string[],
      async () => {
        const conflict = await findConflictingOwnerEvent(strapi, identity.ownerId, {
          transactionIds: [finalTx],
          purchaseTokens: storeToken ? [storeToken] : [],
          originalTransactionIds: storeOriginal ? [storeOriginal] : [],
        });
        if (conflict) return { conflict: true as const };

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
            originalTransactionId: storeOriginal || undefined,
            purchaseToken: storeToken || undefined,
            status: verified.status,
            expiresAt: asString(verified.expiresAt) || undefined,
            payload: verified.payload,
          }),
        );

        const clearsEntitlement = verified.status === 'expired' || verified.status === 'refunded';
        if (verified.verified || (clearsEntitlement && existing)) {
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
            autoRenew: verified.autoRenew,
          });
        }
        return { conflict: false as const };
      },
    );
    if (outcome.conflict) return ctx.forbidden('Bu satin alma farkli bir hesaba bagli.');

    ctx.body = {
      verified: verified.verified,
      success: verified.verified,
      provider,
      productId,
      transactionId: finalTx,
      originalTransactionId: storeOriginal || null,
      status: verified.status,
      expiresAt: asString(verified.expiresAt) || null,
      message: verified.message,
    };
  },

  /**
   * Google Play Real-time Developer Notifications, delivered by a Cloud Pub/Sub
   * PUSH subscription. (1) The request must carry Google's OIDC token for the
   * configured push service account and audience. (2) The notification is only
   * a POINTER: status and expiry are re-read from the Google Play Developer API
   * for that purchase token, never taken from the notification.
   */
  async googleWebhook(ctx: any) {
    const g = googleConfig();
    const auth = await verifyPubSubOidc(asString(ctx.request?.headers?.authorization), {
      audience: g.pubsubAudience,
      serviceAccountEmail: g.pubsubServiceAccountEmail,
    });
    if (!auth.ok) {
      strapi.log.warn(`Google webhook rejected: ${(auth as { reason?: string }).reason}`);
      return ctx.unauthorized('Unauthorized');
    }

    const message = asRecord(asRecord(ctx.request?.body).message);
    const rawData = asString(message.data);
    if (!rawData) return (ctx.body = { ok: true, skipped: true, reason: 'message.data yok' });

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(Buffer.from(rawData, 'base64').toString('utf8'));
    } catch {
      return (ctx.body = { ok: true, skipped: true, reason: 'message.data cozulemedi' });
    }
    if (payload.testNotification) return (ctx.body = { ok: true, skipped: true, reason: 'test' });
    if (asString(payload.packageName) !== g.packageName || !g.packageName) {
      return (ctx.body = { ok: true, skipped: true, reason: 'packageName eslesmiyor' });
    }

    const sub = asRecord(payload.subscriptionNotification);
    const oneTime = asRecord(payload.oneTimeProductNotification);
    const voided = asRecord(payload.voidedPurchaseNotification);
    const purchaseToken =
      asString(sub.purchaseToken) || asString(oneTime.purchaseToken) || asString(voided.purchaseToken);
    if (!purchaseToken) return (ctx.body = { ok: true, skipped: true, reason: 'purchaseToken yok' });

    const existing = await findPurchaseEvent(strapi, { purchaseToken });
    if (!existing) return (ctx.body = { ok: true, skipped: true, reason: 'event bulunamadi' });

    let outcome;
    try {
      outcome = await verifyGoogle({
        productId: asString(existing.productId),
        purchaseToken,
        isSubscription: Boolean(existing.isSubscription),
      });
    } catch (e) {
      strapi.log.error(`Google webhook store lookup failed: ${String(e)}`);
      // Non-2xx so Pub/Sub retries the notification.
      ctx.status = 503;
      return (ctx.body = { ok: false, error: 'store lookup failed' });
    }
    if (outcome.status === 'rejected') {
      return (ctx.body = { ok: true, skipped: true, reason: 'store lookup reddetti' });
    }

    const status: PurchaseStatus = Object.keys(voided).length ? 'refunded' : outcome.status;
    const tx = asString(existing.transactionId);
    const expiresAt = asString(outcome.expiresAt) || undefined;
    await upsertPurchaseEvent(strapi, {
      ...existing,
      status,
      source: 'google_webhook',
      expiresAt: expiresAt ?? null,
      payload: { ...asRecord(existing.payload), googleWebhook: payload, googleStore: outcome.payload },
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
      premiumEndsAt: expiresAt,
      forcePremiumStatus: status,
      autoRenew: outcome.autoRenew,
    });
    ctx.body = { ok: true, status, transactionId: tx };
  },

  /**
   * App Store Server Notifications V2. The signedPayload (and the nested signed
   * transaction) are verified against Apple's certificate chain, pinned to the
   * Apple root; only then are they used. Entitlement dates come from the VERIFIED
   * transaction (expiresDate / revocationDate), never from the client or from a
   * previously stored expiry. Stale or duplicate notifications (older signedDate)
   * are ignored.
   */
  async appleWebhook(ctx: any) {
    const apple = appleConfig();
    if (!apple.bundleId) {
      ctx.status = 503;
      return (ctx.body = { ok: false, error: 'not configured' });
    }
    const signedPayload = asString(asRecord(ctx.request?.body).signedPayload);
    const roots = trustedAppleRoots();
    let decoded: Record<string, unknown>;
    try {
      decoded = verifyAppleJws(signedPayload, { trustedRootSha256: roots });
    } catch (e) {
      strapi.log.warn(`Apple webhook rejected: ${String(e)}`);
      return ctx.unauthorized('Unauthorized');
    }

    const notificationType = asString(decoded.notificationType).toUpperCase();
    const subtype = asString(decoded.subtype).toUpperCase();
    const data = asRecord(decoded.data);
    if (notificationType === 'TEST') return (ctx.body = { ok: true, skipped: true, reason: 'test' });
    if (asString(data.bundleId) !== apple.bundleId) {
      return (ctx.body = { ok: true, skipped: true, reason: 'bundleId eslesmiyor' });
    }
    const signedTx = asString(data.signedTransactionInfo);
    if (!signedTx) return (ctx.body = { ok: true, skipped: true, reason: 'transaction yok' });

    let tx: Record<string, unknown>;
    try {
      tx = verifyAppleJws(signedTx, { trustedRootSha256: roots });
    } catch (e) {
      strapi.log.warn(`Apple webhook transaction rejected: ${String(e)}`);
      return ctx.unauthorized('Unauthorized');
    }
    if (asString(tx.bundleId) !== apple.bundleId) {
      return (ctx.body = { ok: true, skipped: true, reason: 'transaction bundleId eslesmiyor' });
    }

    const transactionId = asString(tx.transactionId);
    const originalTransactionId = asString(tx.originalTransactionId);
    const existing =
      (originalTransactionId
        ? await findPurchaseEvent(strapi, { originalTransactionId })
        : null) || (transactionId ? await findPurchaseEvent(strapi, { transactionId }) : null);
    if (!existing) return (ctx.body = { ok: true, skipped: true, reason: 'event bulunamadi' });

    // Duplicate / out-of-order protection.
    const signedDate = Number(decoded.signedDate ?? 0) || 0;
    const lastSigned = Number(asRecord(existing.payload).appleLastSignedDate ?? 0) || 0;
    if (signedDate && signedDate <= lastSigned) {
      return (ctx.body = { ok: true, skipped: true, reason: 'eski/tekrarlanan bildirim' });
    }

    const nowMs = Date.now();
    const expiresMs = Number(tx.expiresDate ?? 0) || 0;
    const revoked = Number(tx.revocationDate ?? 0) > 0;
    let status: PurchaseStatus;
    if (revoked || notificationType === 'REFUND' || notificationType === 'REVOKE') {
      status = 'refunded';
    } else if (
      notificationType === 'EXPIRED' ||
      notificationType === 'GRACE_PERIOD_EXPIRED' ||
      (expiresMs > 0 && expiresMs <= nowMs)
    ) {
      status = 'expired';
    } else if (notificationType === 'DID_CHANGE_RENEWAL_STATUS' && subtype === 'AUTO_RENEW_DISABLED') {
      status = 'canceled';
    } else if (notificationType === 'DID_FAIL_TO_RENEW') {
      status = 'pending';
    } else {
      status = 'verified';
    }

    const expiresAt = expiresMs > 0 ? new Date(expiresMs).toISOString() : undefined;
    const claimedProduct = asString(tx.productId);
    const productId = ALL_PRODUCTS.has(claimedProduct) ? claimedProduct : asString(existing.productId);
    const tid = asString(existing.transactionId);
    await upsertPurchaseEvent(strapi, {
      ...existing,
      productId,
      status,
      source: 'apple_webhook',
      expiresAt: expiresAt ?? null,
      payload: {
        ...asRecord(existing.payload),
        appleLastSignedDate: signedDate || lastSigned,
        appleWebhook: { notificationType, subtype, environment: asString(data.environment) },
      },
      verifiedAt: new Date().toISOString(),
      transactionId: tid,
    });
    await upsertProfilePurchase(strapi, {
      ownerId: asString(existing.ownerProfileId),
      categoryTitle: asString(existing.categoryTitle),
      planTitle: asString(existing.planTitle),
      priceTl: Number(existing.priceTl ?? 0) || 0,
      provider: 'app_store',
      transactionId: tid,
      productId,
      premiumEndsAt: expiresAt,
      forcePremiumStatus: status,
    });
    ctx.body = { ok: true, status, transactionId: tid };
  },
});
