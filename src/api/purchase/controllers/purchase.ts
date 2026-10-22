import crypto from 'crypto';
import type { Core } from '@strapi/strapi';
import {
  ALL_PRODUCTS,
  asString,
  normalizeProvider,
  parseIso,
  PREMIUM_PRODUCTS,
  PurchaseStatus,
  resolveCanonicalProductId,
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
  everAuthenticated: boolean;
  purchasedAt?: string;
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
  // Review follow-up (real production symptom): the store's own verified
  // purchase time for this exact transaction -- see `purchasedAt`'s doc
  // comment on `VerifyOutcome` (lib/providers.ts). Distinct from
  // `verifiedAt` above (always "now", when OUR backend processed this),
  // which a redelivered/restored/late-reprocessed transaction can set to
  // a date far after the real purchase. Never set when the provider could
  // not supply one (e.g. a rejected/unauthenticated outcome).
  purchasedAt: input.purchasedAt || null,
  payload: input.payload ?? null,
  source: 'verify_api',
  everAuthenticated: input.everAuthenticated,
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
    // Flutter's StrapiService already parses `error.details.reasonCode`/
    // `correlationId` on a 403 (PurchaseVerifyOutcome._reasonCodeFromWire,
    // PurchaseVerifyReasonCode.ownerMismatch/tokenConflict/identityConflict)
    // -- this backend never sent that `details` object, so every one of
    // the three ownership/token/identity conflict checks below landed on
    // the fully generic fallback (no specific reasonCode, just the plain
    // message string) instead of the specific, already-built code path.
    // `correlationId` is safe to show/share with support: a fresh,
    // per-request random id, never a secret, never the other account's
    // identity, never the receipt/JWS/any provider payload.
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

    // Review follow-up (Premium entitlement audit): this used to be
    // `Boolean(body.isSubscription)` -- the CLIENT's own, unchecked
    // claim -- and fed straight into `verifyWithProvider`, which uses it
    // to pick verifyApple/verifyGoogle's subscription-vs-one-time branch
    // (expiresDate/revocationDate checks vs a single-purchaseState
    // check). A client that sent the wrong value for a given productId
    // would make the provider verifier apply the WRONG kind of check to
    // a real transaction -- never trusted here anymore. The backend's
    // own catalog is the single source of truth for which productId is
    // a subscription: `productId` has already been confirmed to be in
    // `ALL_PRODUCTS` above, so resolving it to its canonical id and
    // checking `PREMIUM_PRODUCTS` is authoritative and always available.
    const isSubscription = Boolean(PREMIUM_PRODUCTS[resolveCanonicalProductId(productId)]);

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
    //
    // Review follow-up (unverified-claim ownership lock): `existing` here was
    // looked up by a value the CALLER supplied (or a hash derived from their
    // own receipt) -- never yet confirmed by the provider. A row only blocks
    // a different account when it is NOT explicitly known to be
    // `everAuthenticated === false` (never, across every attempt so far,
    // backed by a receipt/token the provider's own signature/API check
    // actually accepted). `undefined`/`null` (a legacy row from before this
    // field existed) stays protective, exactly as before this fix -- only an
    // explicit `false` lifts the block, and only for THIS mismatch branch; the
    // idempotent-success branch below is unaffected (it already requires the
    // SAME owner).
    const existing = await findPurchaseEvent(strapi, { transactionId });
    if (existing) {
      if (asString(existing.ownerProfileId) !== identity.ownerId) {
        if (existing.everAuthenticated !== false) {
          return ctx.forbidden('Bu satin alma farkli bir hesaba ait.', {
            reasonCode: 'owner_mismatch',
            correlationId,
          });
        }
        // Else: every prior attempt on this exact transactionId was itself
        // never provider-authenticated (empty receipt, bad signature, or a
        // non-crypto bundle/product mismatch) -- an unverified claim, not a
        // real prior owner. Falls through to verify THIS request normally.
      } else if (
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
      if (early) {
        return ctx.forbidden('Bu satin alma farkli bir hesaba bagli.', {
          reasonCode: 'token_conflict',
          correlationId,
        });
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
      return ctx.badRequest('Dogrulama su anda yapilamiyor.');
    }
    const finalTx = asString(verified.transactionId) || transactionId;
    const storeToken = asString(verified.purchaseToken) || purchaseToken;
    const storeOriginal = asString(verified.originalTransactionId);
    // Review follow-up (unverified-claim ownership lock): read directly from
    // the provider's own EXPLICIT signal (`VerifyOutcome.identityAuthenticated`,
    // set at each return in providers.ts) -- never inferred indirectly from
    // the mere presence of `transactionId` or any other field, which would
    // be fragile to a future, unrelated change there. True for refunded/
    // expired/mismatched-subscription-state outcomes (still a REAL,
    // correctly-identified transaction, just not currently active/entitled),
    // false for an empty receipt, a bad signature, or a genuinely-signed
    // transaction for the WRONG bundle/product (that sender must never win
    // ownership of the identity THIS request claims). Deliberately NOT
    // `verified.verified` (which would also -- wrongly -- fail to protect a
    // real purchase that has since legitimately expired or been refunded).
    const everAuthenticated = verified.identityAuthenticated === true;

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
            everAuthenticated,
            purchasedAt: asString(verified.purchasedAt) || undefined,
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
            // Review follow-up: the STABLE identity of a subscription
            // across its whole lifetime -- Apple's own originalTransactionId
            // for app_store, Google's own purchaseToken for google_play
            // (Google's `linkedPurchaseToken`/our own `storeOriginal` here
            // is a DIFFERENT concept -- "this NEW token replaces that OLD
            // one" -- not the stable per-subscription identity a later
            // notification about the SAME ongoing subscription repeats).
            originalTransactionId:
              (provider === 'google_play' ? storeToken : storeOriginal) || undefined,
            purchasedAt: asString(verified.purchasedAt) || undefined,
          });
        }
        return { conflict: false as const };
      },
    );
    if (outcome.conflict) {
      return ctx.forbidden('Bu satin alma farkli bir hesaba bagli.', {
        reasonCode: 'identity_conflict',
        correlationId,
      });
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
      purchasedAt: asString(outcome.purchasedAt) || existing.purchasedAt || null,
      payload: { ...asRecord(existing.payload), googleWebhook: payload, googleStore: outcome.payload },
      verifiedAt: new Date().toISOString(),
      transactionId: tx,
      // Review follow-up: a webhook is Google's own authenticated
      // server-to-server notification (OIDC-verified before reaching
      // here), never an unauthenticated client claim -- merges with
      // (never regresses) whatever `existing.everAuthenticated` already
      // was via `upsertPurchaseEvent`'s own merge logic.
      everAuthenticated: true,
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
      // purchaseToken is the stable identity of this subscription across
      // its whole lifetime for Google -- see the interactive verify()
      // call site's own comment on this same field.
      originalTransactionId: purchaseToken || undefined,
      purchasedAt: asString(outcome.purchasedAt) || undefined,
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

    // Duplicate / out-of-order protection -- OUTER envelope. Catches a
    // literal duplicate or a notification whose own delivery/signing was
    // reordered.
    const signedDate = Number(decoded.signedDate ?? 0) || 0;
    const lastSigned = Number(asRecord(existing.payload).appleLastSignedDate ?? 0) || 0;
    if (signedDate && signedDate <= lastSigned) {
      return (ctx.body = { ok: true, skipped: true, reason: 'eski/tekrarlanan bildirim' });
    }

    // Review follow-up (same-subscription renewal ordering): the OUTER
    // check above only bounds the ENVELOPE's own signedDate -- it does not
    // prove the INNER transaction snapshot (`tx`, decoded separately above)
    // actually describes the subscription's current period. Apple's own
    // JWSTransactionDecodedPayload carries its own `signedDate` (when it
    // generated THIS transaction's data), independent of when the outer
    // notification envelope itself was signed/(re)delivered. Do not treat
    // "the envelope's signedDate is newer" as proof "the transaction data
    // inside it is newer" -- a resent/retried envelope could legitimately
    // carry a fresh outer signedDate while reusing an older, already-
    // superseded inner transaction snapshot (e.g. describing a renewal
    // period a later, separately-processed renewal has already extended
    // past). Guard on the inner signedDate too, tracked independently of
    // the outer one; when Apple does not include it, this stays permissive
    // (no inner signal to compare, outer check above already applied).
    const txSignedDate = Number(tx.signedDate ?? 0) || 0;
    const lastTxSigned = Number(asRecord(existing.payload).appleLastTransactionSignedDate ?? 0) || 0;
    if (txSignedDate && txSignedDate <= lastTxSigned) {
      return (ctx.body = { ok: true, skipped: true, reason: 'eski/tekrarlanan islem verisi' });
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
    const purchaseMs = Number(tx.purchaseDate ?? 0) || 0;
    const purchasedAt = purchaseMs > 0 ? new Date(purchaseMs).toISOString() : undefined;
    const claimedProduct = asString(tx.productId);
    const productId = ALL_PRODUCTS.has(claimedProduct) ? claimedProduct : asString(existing.productId);
    const tid = asString(existing.transactionId);
    await upsertPurchaseEvent(strapi, {
      ...existing,
      productId,
      status,
      source: 'apple_webhook',
      expiresAt: expiresAt ?? null,
      purchasedAt: purchasedAt ?? (existing as Record<string, unknown>).purchasedAt ?? null,
      payload: {
        ...asRecord(existing.payload),
        appleLastSignedDate: signedDate || lastSigned,
        appleLastTransactionSignedDate: txSignedDate || lastTxSigned,
        appleWebhook: { notificationType, subtype, environment: asString(data.environment) },
      },
      verifiedAt: new Date().toISOString(),
      transactionId: tid,
      // Review follow-up: Apple's own authenticated server notification
      // (JWS-signature-verified before reaching here), never an
      // unauthenticated client claim -- merges with (never regresses)
      // whatever `existing.everAuthenticated` already was.
      everAuthenticated: true,
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
      // originalTransactionId is the stable identity of this subscription
      // across its whole lifetime for Apple -- see the interactive
      // verify() call site's own comment on this same field. This is
      // exactly what stops a late/duplicate notification about an OLD,
      // already-superseded originalTransactionId from nulling a CURRENT
      // entitlement that a genuinely different, newer transaction produced.
      originalTransactionId: originalTransactionId || undefined,
      purchasedAt,
    });
    ctx.body = { ok: true, status, transactionId: tid };
  },
});
