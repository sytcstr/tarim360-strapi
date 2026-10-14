import crypto from 'crypto';
import type { Core } from '@strapi/strapi';
import {
  ALL_PRODUCTS,
  asString,
  normalizeProvider,
  parseIso,
  PurchaseStatus,
} from '../lib/catalog';
import {
  allowSandboxPurchaseEntitlements,
  appleConfig,
  googleConfig,
  isSoftVerifyRefused,
  trustedAppleRoots,
} from '../lib/config';
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
  storeEnvironment?: string;
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
  // "Paketler ve Fiyatlar" audit follow-up: null for Google (no
  // equivalent signal) -- only Apple rows are ever tagged either way.
  storeEnvironment: input.storeEnvironment || null,
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

/**
 * "Paketler ve Fiyatlar" follow-up: the three ownership/conflict checks
 * below (existing-event owner mismatch, early purchaseToken pre-check,
 * authoritative store-identity lock conflict) are all distinct REASONS a
 * real purchase can be rejected, but they used to all answer with the
 * exact same opaque 403 -- which Flutter's own generic error mapping
 * (strapi_service.dart's `isForbidden` branch) then collapses into
 * "Bu işlem için yetkiniz bulunmuyor." regardless of which one fired.
 * That made it impossible to tell, from the client alone, "this is a
 * genuine cross-account conflict" apart from "something else entirely"
 * -- and worse, impossible to tell a human support agent which specific
 * check to investigate. `reasonCode` and `correlationId` (logged
 * server-side, returned to the client, never the other account's
 * identity) close that gap without loosening anything: the three
 * checks' OWN logic is completely unchanged.
 */
type PurchaseForbiddenReasonCode =
  | 'owner_mismatch'
  | 'token_conflict'
  | 'identity_conflict'
  /**
   * "Paketler ve Fiyatlar" audit follow-up (second pass): this backend
   * has exactly ONE entitlement store (profile-setting's activePremium/
   * activePremiumSubscription, plus the doping/listing-quota counters
   * derived directly from purchase-event rows) and no separate sandbox
   * deployment/table -- TestFlight and the real App Store point at the
   * SAME production data. A genuinely verified Apple SANDBOX transaction
   * is therefore rejected outright here rather than silently granted
   * (previous behaviour) or silently dropped: the store's own signature
   * check did pass (Apple confirmed this is a real sandbox transaction),
   * but this backend has nowhere safe to credit it without risking a
   * real customer's real entitlement. See upsertProfilePurchase's own
   * guard for the second, defense-in-depth layer (covers the webhook
   * path and any legacy/pre-existing sandbox-tagged row).
   */
  | 'sandbox_unsupported';

const purchaseForbidden = (
  ctx: any,
  message: string,
  reasonCode: PurchaseForbiddenReasonCode,
  correlationId: string,
) => {
  ctx.status = 403;
  ctx.body = {
    data: null,
    error: {
      status: 403,
      name: 'ForbiddenError',
      message,
      details: { reasonCode, correlationId },
    },
  };
};

/** Same explicit-body approach as `purchaseForbidden` -- not relying on
 * whichever exact signature Strapi's own `ctx.badRequest` helper happens
 * to accept for a details object, so `correlationId` reliably reaches
 * the response either way. `transient` tells the client whether this
 * specific 400 is worth an automatic later retry (a provider outage/
 * network hiccup during verification) or a permanent client-side
 * mistake (unknown product id, missing field) retrying can never fix. */
const purchaseBadRequest = (
  ctx: any,
  message: string,
  correlationId: string,
  transient = false,
) => {
  ctx.status = 400;
  ctx.body = {
    data: null,
    error: {
      status: 400,
      name: 'ValidationError',
      message,
      details: { correlationId, transient },
    },
  };
};

export default ({ strapi }: { strapi: Core.Strapi }) => ({
  async verify(ctx: any) {
    const correlationId = crypto.randomUUID();
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

    // "Paketler ve Fiyatlar" audit follow-up: the provider is now verified
    // FIRST, unconditionally -- every lookup/conflict/idempotency/
    // entitlement decision below uses the REAL, signature-verified
    // transactionId/originalTransactionId/environment this returns, never
    // the client-supplied (or hash-fallback) guess above. The guess is
    // still computed (it is `verifyWithProvider`'s own fallback hint, and
    // the final response's identifier if the provider never returns one),
    // but it no longer drives any security decision on its own. This
    // closes a real gap: the OLD code ran the early idempotent-replay and
    // owner-mismatch checks against the pre-decode guess, which could not
    // know the request's real environment (Apple's Sandbox/Production is
    // only knowable AFTER decoding the JWS) -- a same-looking transaction
    // id guessed/collided across two different environments could have
    // short-circuited into the WRONG existing row's identity/entitlement.
    // For Apple this costs nothing extra (JWS verification is local
    // cryptography, no network call); for Google this does mean an exact
    // idempotent retry now re-asks Google's API instead of short-
    // circuiting first -- a deliberate, disclosed correctness-over-
    // micro-optimization trade-off.
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
      // Never log the caught exception's own message/stack verbatim here --
      // on some provider failure paths it can embed the raw receipt/token
      // that was being parsed. Only the correlationId + product/provider are
      // logged; the full error is available to Strapi's own unhandled-
      // exception path if this were ever to escape instead of being caught.
      strapi.log.error(
        `[purchase.verify] ${correlationId} provider verify threw (productId=${productId}, provider=${provider})`,
      );
      return purchaseBadRequest(ctx, 'Dogrulama su anda yapilamiyor.', correlationId, true);
    }
    const finalTx = asString(verified.transactionId) || transactionId;
    const storeToken = asString(verified.purchaseToken) || purchaseToken;
    const storeOriginal = asString(verified.originalTransactionId);
    const storeEnvironment = verified.storeEnvironment;

    // "Paketler ve Fiyatlar" audit follow-up (second pass): a genuinely
    // verified Apple SANDBOX (TestFlight) transaction is rejected here,
    // explicitly and before any row is written -- this backend has no
    // separate sandbox entitlement store (TestFlight and the real App
    // Store share the exact same profile-setting/purchase-event tables),
    // so there is no safe place to credit it. Previously this either
    // silently granted a tagged-sandbox entitlement to an account with
    // none yet, or (prior round) silently no-opped while still answering
    // `verified: true` -- both left the caller unable to tell a sandbox
    // purchase was never actually going to unlock anything real. This
    // never touches Google (no sandbox/production signal exists there)
    // and never touches a production/legacy (untagged) Apple transaction.
    //
    // THIRD PASS: a genuinely separate test-backend deployment (its own
    // process, its own database -- never the production one) may opt
    // in via `allowSandboxPurchaseEntitlements()` so a TestFlight build
    // pointed AT THAT deployment can still validate the purchase flow
    // end-to-end. That flag is itself gated to NODE_ENV development/test
    // (see config.ts) -- a real production deployment ignores it even
    // if it were ever accidentally set.
    if (provider === 'app_store' && storeEnvironment === 'sandbox' && !allowSandboxPurchaseEntitlements()) {
      strapi.log.warn(
        `[purchase.verify] ${correlationId} reasonCode=sandbox_unsupported productId=${productId} provider=${provider}`,
      );
      return purchaseForbidden(
        ctx,
        'TestFlight/sandbox satin almalari bu ortamda gercek bir hakka donusturulemiyor (ayri bir sandbox hak deposu yapilandirilmamis).',
        'sandbox_unsupported',
        correlationId,
      );
    }

    // A client-supplied/pre-decode transaction id was only ever a lookup
    // hint for retries; it is never an ownership decision, and now that
    // `finalTx` is the real, provider-verified identifier, this lookup can
    // never land on the wrong row just because a client guess happened to
    // match something else. The stored event must belong to the caller,
    // and a still-valid verified event IN THE SAME ENVIRONMENT is answered
    // idempotently.
    const existing = await findPurchaseEvent(strapi, { transactionId: finalTx });
    if (existing) {
      if (asString(existing.ownerProfileId) !== identity.ownerId) {
        strapi.log.warn(
          `[purchase.verify] ${correlationId} reasonCode=owner_mismatch productId=${productId} provider=${provider}`,
        );
        return purchaseForbidden(
          ctx,
          'Bu satin alma farkli bir hesaba ait.',
          'owner_mismatch',
          correlationId,
        );
      }
      const existingEnv = asString(existing.storeEnvironment);
      // Fail-safe: a legacy row with no stored environment, or one that
      // genuinely matches, is eligible for the idempotent shortcut. A row
      // that explicitly recorded a DIFFERENT environment than this exact
      // request's real one (the same transactionId string reused across
      // environments -- not realistic for genuine Apple-issued ids, but
      // never silently trusted either) falls through to full
      // verification/creation below instead of being short-circuited.
      const envConsistent =
        !storeEnvironment || !existingEnv || existingEnv === storeEnvironment;
      if (
        envConsistent &&
        asString(existing.status).toLowerCase() === 'verified' &&
        !isExpired(existing.expiresAt)
      ) {
        ctx.body = {
          verified: true,
          success: true,
          idempotent: true,
          provider,
          productId,
          transactionId: finalTx,
          message: 'Islem daha once dogrulanmis.',
          correlationId,
        };
        return;
      }
    }

    // Cheap pre-check on what the store identity already is (Google token
    // -- Apple's `purchaseToken` is always empty, this never fires for it).
    if (purchaseToken) {
      const early = await findConflictingOwnerEvent(strapi, identity.ownerId, {
        purchaseTokens: [purchaseToken],
        storeEnvironment,
      });
      if (early) {
        strapi.log.warn(
          `[purchase.verify] ${correlationId} reasonCode=token_conflict productId=${productId} provider=${provider}`,
        );
        return purchaseForbidden(
          ctx,
          'Bu satin alma farkli bir hesaba bagli.',
          'token_conflict',
          correlationId,
        );
      }
    }

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
          // "Paketler ve Fiyatlar" audit follow-up: scopes the conflict
          // check to the SAME environment a sandbox (TestFlight) vs a
          // real production Apple transaction were made in -- a legacy
          // row with no stored environment (every row persisted before
          // this fix) is NOT exempted either way (fail-safe: still
          // conflicts regardless of the current request's environment).
          // This never weakens the check within one environment; it only
          // stops two DIFFERENT environments' own, separate transaction
          // pools from being able to false-conflict with each other.
          storeEnvironment: verified.storeEnvironment,
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
            storeEnvironment: verified.storeEnvironment,
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
            storeEnvironment,
          });
        }
        return { conflict: false as const };
      },
    );
    if (outcome.conflict) {
      strapi.log.warn(
        `[purchase.verify] ${correlationId} reasonCode=identity_conflict productId=${productId} provider=${provider}`,
      );
      return purchaseForbidden(
        ctx,
        'Bu satin alma farkli bir hesaba bagli.',
        'identity_conflict',
        correlationId,
      );
    }

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
      correlationId,
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
      // "Paketler ve Fiyatlar" audit follow-up: the AUTHORITATIVE value
      // for this guard is what was stored when this exact row was first
      // verified (via /purchases/verify), not re-derived from this one
      // notification's own claim -- a sandbox renewal/cancellation
      // notification must be just as unable to touch a real production
      // entitlement as a sandbox /purchases/verify call is.
      storeEnvironment: asString(existing.storeEnvironment) || undefined,
    });
    ctx.body = { ok: true, status, transactionId: tid };
  },
});
