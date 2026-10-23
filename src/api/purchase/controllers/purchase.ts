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

/**
 * Review follow-up (stale-JWS resurrection guard): a client resubmitting an
 * OLD, already-frozen Apple transaction JWS (its own locally cached copy,
 * from before a LATER webhook recorded a refund/expiry/cancellation) always
 * decodes as whatever it said at signing time -- it cannot reflect anything
 * that happened after. `verifyApple`'s own re-decode proves the JWS is
 * validly signed, never that it is CURRENT. The one real signal this
 * backend has for "is there already-known, more current truth than this
 * JWS" is `appleLastTransactionSignedDate` -- the inner transaction
 * signedDate `appleWebhook` already tracks every time a real Apple
 * notification updates this row. If THIS request's own JWS signedDate is
 * OLDER than that, it is provably stale and must never be allowed to
 * establish/overwrite anything -- a genuine newer renewal always carries a
 * later signedDate, so this never blocks real renewals, only resubmissions
 * of old data. Apple only (`provider === 'app_store'`) -- Google's
 * verification is already a live Play Developer API call, so it has no
 * equivalent staleness problem.
 *
 * Review follow-up (corrects an off-by-equality bug): strictly OLDER
 * (`<`), never `<=`. An EQUAL signedDate means this JWS describes the
 * EXACT SAME already-known transaction state -- the ordinary case of a
 * client resubmitting its own still-valid, never-refunded receipt (e.g.
 * a retry, or the same transaction a webhook already touched once with
 * identical data) -- and must be treated as fine, not stale. Only a
 * STRICTLY OLDER signedDate proves this JWS predates something more
 * recent that is already known.
 */
const isStaleAppleResubmission = (
  providerName: string,
  existingPayload: unknown,
  thisSignedDate: number | undefined,
): boolean => {
  if (providerName !== 'app_store' || !thisSignedDate) return false;
  const lastKnown = Number(asRecord(existingPayload).appleLastTransactionSignedDate ?? 0) || 0;
  return lastKnown > 0 && thisSignedDate < lastKnown;
};

/**
 * Review follow-up (closes a gap `isStaleAppleResubmission` alone does not
 * cover): that check only catches a JWS whose OWN signedDate is OLDER than
 * what is already known -- it says nothing about a JWS with a NEWER
 * signedDate that simply does not itself report the already-known
 * destructive outcome (no revocationDate, a future expiresDate -- it looks
 * fine entirely on its own terms). Confirmed to actually happen with the
 * current code: a webhook-recorded refund for a transactionId could be
 * reopened by resubmitting a later-signed, "clean-looking" JWS for that
 * SAME transactionId.
 *
 * The fix does not depend on signedDate at all: once THIS EXACT
 * transactionId already has a server-recorded (webhook-driven) terminal
 * outcome -- refunded or expired -- that is permanent from the
 * interactive verify() path's point of view. A client's own freshly
 * re-decoded JWS can never flip it back to "verified", no matter its
 * signedDate; only a webhook (Apple's own authoritative push) can ever
 * change it. A genuinely NEW renewal is never blocked by this -- it
 * always carries its OWN, different transactionId, which has no prior
 * terminal record of its own at all.
 *
 * Deliberately NARROW -- `rejected` and `canceled` are excluded:
 *  - `rejected` is routinely produced by an UNVERIFIED claim (empty
 *    receipt, bad signature, bundle/product mismatch -- `everAuthenticated:
 *    false`), which the "unverified claim must never lock out a later
 *    genuine owner" fix (elsewhere in this file) depends on being
 *    overridable by that owner's real data. Including it here broke
 *    exactly that -- caught by this file's own existing tests for it,
 *    while verifying this fix.
 *  - `canceled` only means auto-renew was turned off -- the subscription
 *    stays genuinely active until its real expiry, and the SAME owner
 *    re-enabling auto-renew for the SAME transactionId is a legitimate
 *    state change, not a resurrection.
 */
const TERMINAL_STATUSES = new Set(['refunded', 'expired']);
const isPermanentlyTerminalForSameTransaction = (
  providerName: string,
  existingStatus: unknown,
): boolean => providerName === 'app_store' && TERMINAL_STATUSES.has(asString(existingStatus).toLowerCase());

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
        const profileRow = await strapi.db
          .query('api::profile-setting.profile-setting')
          .findOne({ where: { profileId: identity.ownerId } } as any);
        const hasAnyEntitlement = Boolean(
          (profileRow as Record<string, unknown> | null)?.activePremium ||
            (profileRow as Record<string, unknown> | null)?.activePremiumSubscription,
        );

        // Review follow-up (FOURTH PASS -- closes a gap found while
        // verifying the THIRD pass's own fix): the fast path used to
        // return idempotent success whenever ANY entitlement already
        // existed, WITHOUT EVER inspecting this request's own receipt --
        // so a client holding a freshly-signed Apple JWS that already
        // reveals a genuine revocation (e.g. StoreKit2 has refreshed the
        // transaction locally before our webhook arrived) was waved
        // through unexamined. For Google this fast path is kept exactly
        // as it was -- `verifyGoogle` is a LIVE Play Developer API call,
        // so skipping it here is a deliberate cost/latency/quota
        // decision, not a correctness gap; Google's state can never go
        // stale the way a locally-decoded Apple JWS can.
        if (hasAnyEntitlement && provider !== 'app_store') {
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

        // Review follow-up (THIRD PASS -- corrects the second pass's own
        // overclaim): `verifyWithProvider` re-decoding the SAME JWS the
        // client already submitted is NOT a live query of Apple's current
        // refund status -- confirmed by reading `verifyApple` (providers.ts):
        // it is pure local certificate-chain verification of whatever
        // receipt bytes are IN THIS REQUEST, no network call, no ability to
        // learn anything Apple hasn't already told us. Apple's real
        // "current state" signal for a transaction we already hold is the
        // webhook (`appleWebhook`) updating THIS SAME purchase-event row's
        // own `status` whenever Apple's server pushes a
        // refund/revoke/expire notification -- which is exactly what the
        // `else if` above already gates on (`status === 'verified' &&
        // !isExpired`). So the real risk here is not "Apple's live state is
        // unknown" (there is no such live-query API in this codebase, for
        // either provider's Apple path, and this call is never presented as
        // one) -- it is that a webhook could update that SAME status WHILE
        // this repair's own async work is in flight, and the write must
        // never use the stale value captured earlier. Calling
        // `verifyWithProvider` here is cheap for Apple (local decode, no
        // network) and is the only way to catch a FRESHER JWS the client
        // already holds; the actual freshness guarantee against a
        // concurrent webhook is the re-fetch of the purchase-event row
        // INSIDE the lock, right before writing, further below.
        let reverified;
        try {
          reverified = await verifyWithProvider({
            provider,
            productId,
            receipt,
            purchaseToken,
            isSubscription,
            fallbackTransactionId: transactionId,
          });
        } catch (e) {
          strapi.log.error(`Idempotent-repair re-verify exception: ${String(e)}`);
          ctx.status = 503;
          ctx.body = { ok: false, error: 'Dogrulama su anda yapilamiyor, lutfen daha sonra tekrar deneyin.' };
          return;
        }

        if (!reverified.verified) {
          // Review follow-up: a resubmission whose OWN signedDate is
          // OLDER than what is already known (`isStaleAppleResubmission`)
          // must never be allowed to act on this "invalid" reading --
          // it is the resubmission that is stale, not the stored
          // entitlement; answered as an ordinary idempotent success,
          // exactly as if this old JWS had never been inspected at all.
          if (isStaleAppleResubmission(provider, existing.payload, reverified.signedDate)) {
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
          if (hasAnyEntitlement) {
            // A genuinely fresher JWS reveals this transaction is no
            // longer valid -- apply the SAME destructive handling a
            // normal (non-idempotent) verify() would, inside the SAME
            // identity lock, re-checking the row fresh right before
            // writing (a concurrent webhook could have already handled
            // this, or already established a newer, different
            // entitlement that must never be touched here).
            await withPurchaseIdentityLock(
              [`tx:${asString(existing.transactionId) || transactionId}`],
              async () => {
                const freshEvent = await findPurchaseEvent(strapi, {
                  transactionId: asString(existing.transactionId) || transactionId,
                });
                if (
                  freshEvent &&
                  asString(freshEvent.status).toLowerCase() === 'verified' &&
                  !isExpired(freshEvent.expiresAt) &&
                  !isStaleAppleResubmission(provider, freshEvent.payload, reverified.signedDate)
                ) {
                  await upsertPurchaseEvent(
                    strapi,
                    eventDataForVerify({
                      ownerEmail: identity.email,
                      ownerProfileId: identity.ownerId,
                      provider,
                      productId,
                      categoryTitle: asString(freshEvent.categoryTitle) || categoryTitle,
                      planTitle: asString(freshEvent.planTitle) || planTitle,
                      priceTl: Number(freshEvent.priceTl ?? priceTl) || priceTl,
                      isSubscription,
                      transactionId: asString(freshEvent.transactionId) || transactionId,
                      originalTransactionId: asString(freshEvent.originalTransactionId) || undefined,
                      purchaseToken: asString(freshEvent.purchaseToken) || undefined,
                      status: reverified.status,
                      expiresAt: asString(reverified.expiresAt) || undefined,
                      payload: reverified.payload,
                      everAuthenticated: true,
                      purchasedAt: asString(reverified.purchasedAt) || undefined,
                    }),
                  );
                  await upsertProfilePurchase(strapi, {
                    ownerId: identity.ownerId,
                    categoryTitle: asString(freshEvent.categoryTitle) || categoryTitle,
                    planTitle: asString(freshEvent.planTitle) || planTitle,
                    priceTl: Number(freshEvent.priceTl ?? priceTl) || priceTl,
                    provider,
                    transactionId: asString(freshEvent.transactionId) || transactionId,
                    productId,
                    premiumEndsAt: asString(reverified.expiresAt) || undefined,
                    forcePremiumStatus: reverified.status,
                    originalTransactionId: asString(freshEvent.originalTransactionId) || undefined,
                    purchasedAt: asString(reverified.purchasedAt) || undefined,
                  });
                }
              },
            );
          }
          ctx.body = {
            verified: false,
            success: false,
            provider,
            productId,
            transactionId,
            status: reverified.status,
            message: reverified.message,
          };
          return;
        }

        if (hasAnyEntitlement) {
          // Re-verified fresh and still genuinely valid, and something is
          // already granted -- a harmless duplicate/retry, nothing to do.
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

        // Still genuinely valid. `activePremium` being missing does NOT
        // prove no rocket credits were consumed under this exact
        // subscription period -- the same bug that nulled it could have
        // struck AFTER some premium-credit rocket activations already ran
        // (the real listing.ts activateRocket flow records each one with
        // sourceType:'premium_credit', scoped to `ownerProfileId`).
        // Review follow-up (THIRD PASS): `verifiedAt` is rewritten on
        // EVERY event for this row, including ones that never represent a
        // new period (e.g. DID_CHANGE_RENEWAL_STATUS, DID_FAIL_TO_RENEW) --
        // using it as the period-start cutoff could silently push the
        // cutoff LATER than the real period start, excluding genuine
        // in-period consumption from the count and OVER-crediting rocket
        // credits that were actually already used. `purchasedAt` is the
        // correct anchor instead: Apple's own `purchaseDate` on a renewal
        // transaction reflects THAT renewal's own charge time (confirmed
        // against Apple's documented semantics), so it only moves forward
        // on a GENUINE new period, never on an unrelated notification --
        // and it is scoped to THIS owner (`ownerProfileId: identity.ownerId`)
        // so a different account's consumption is never counted, and to
        // THIS transaction's own period (never an older, already-concluded
        // one) since anything from before this exact period's purchasedAt
        // is excluded by construction. When no reliable purchasedAt exists
        // (a legacy row from before that field existed, or the query
        // itself fails), the safe default is 0, NEVER the full package.
        const spec = PREMIUM_PRODUCTS[resolveCanonicalProductId(productId)];
        const rocketTotal = spec?.rocketIncludedTotal ?? 0;
        let rocketRemainingOverride = 0;
        try {
          const sinceIso = asString((existing as Record<string, unknown>).purchasedAt);
          const sinceDate = sinceIso ? new Date(sinceIso) : null;
          if (sinceDate && !Number.isNaN(sinceDate.getTime())) {
            const consumed = await strapi.db.query('api::rocket-activation.rocket-activation').count({
              where: {
                ownerProfileId: identity.ownerId,
                sourceType: 'premium_credit',
                createdAt: { $gte: sinceDate.toISOString() },
              },
            } as any);
            rocketRemainingOverride = Math.max(0, rocketTotal - Number(consumed || 0));
          }
        } catch (e) {
          strapi.log.error(`Idempotent-repair rocket reconciliation failed: ${String(e)}`);
          rocketRemainingOverride = 0;
        }

        const repairOutcome = await withPurchaseIdentityLock(
          [`tx:${asString(existing.transactionId) || transactionId}`],
          async () => {
            // Re-check inside the lock -- a concurrent repair for this
            // exact same missing entitlement may have already finished.
            const freshProfile = await strapi.db
              .query('api::profile-setting.profile-setting')
              .findOne({ where: { profileId: identity.ownerId } } as any);
            const alreadyRepaired = Boolean(
              (freshProfile as Record<string, unknown> | null)?.activePremium ||
                (freshProfile as Record<string, unknown> | null)?.activePremiumSubscription,
            );
            if (alreadyRepaired) return { ok: true as const };

            // The REAL freshness guarantee for Apple (see this block's own
            // doc comment above): re-fetch the purchase-event row right
            // before writing -- a webhook could have updated its status
            // (a genuine refund/expiry notification) while the work above
            // was in flight. Never write using the value captured earlier.
            const freshEvent = await strapi.db
              .query('api::purchase-event.purchase-event')
              .findOne({ where: { transactionId: asString(existing.transactionId) || transactionId } } as any);
            // Review follow-up (stale-JWS resurrection guard): on top of
            // the status re-check above, THIS request's own JWS
            // (`reverified.signedDate`) must not be older than whatever
            // transaction signedDate a webhook has already recorded --
            // same reasoning and helper as the normal verify() flow
            // above (`isStaleAppleResubmission`'s own doc comment).
            const stillValid =
              Boolean(freshEvent) &&
              asString((freshEvent as Record<string, unknown>).status).toLowerCase() === 'verified' &&
              !isExpired((freshEvent as Record<string, unknown>).expiresAt) &&
              !isStaleAppleResubmission(
                provider,
                (freshEvent as Record<string, unknown> | null)?.payload,
                reverified.signedDate,
              );
            if (!stillValid) {
              return {
                ok: false as const,
                status: asString((freshEvent as Record<string, unknown> | null)?.status) || 'expired',
              };
            }

            await upsertProfilePurchase(strapi, {
              ownerId: identity.ownerId,
              categoryTitle: asString(existing.categoryTitle),
              planTitle: asString(existing.planTitle),
              priceTl: Number(existing.priceTl ?? 0) || 0,
              provider,
              transactionId: asString(existing.transactionId) || transactionId,
              productId: asString(existing.productId) || productId,
              premiumEndsAt: asString(reverified.expiresAt) || asString(existing.expiresAt) || undefined,
              originalTransactionId: asString(existing.originalTransactionId) || undefined,
              purchasedAt: asString((existing as Record<string, unknown>).purchasedAt) || undefined,
              rocketRemainingOverride,
            });
            return { ok: true as const };
          },
        );

        if (!repairOutcome.ok) {
          ctx.body = {
            verified: false,
            success: false,
            provider,
            productId,
            transactionId,
            status: repairOutcome.status,
            message: 'Islem artik gecerli degil.',
          };
          return;
        }

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

        // Review follow-up (stale-JWS resurrection guard): re-read the
        // purchase-event row INSIDE this lock -- `appleWebhook`/
        // `googleWebhook` now acquire this exact same lock (same
        // `tx:`/`orig:`/`tok:` keys) before writing, so nothing can land
        // between this read and the writes below. If a webhook already
        // recorded a NEWER transaction signedDate than what THIS
        // request's own JWS carries, this is a stale resubmission of
        // already-superseded data and must never overwrite the already-
        // known, more current truth (see `isStaleAppleResubmission`'s own
        // doc comment).
        const freshExisting = await findPurchaseEvent(strapi, { transactionId: finalTx });
        if (
          freshExisting &&
          verified.verified &&
          isPermanentlyTerminalForSameTransaction(provider, freshExisting.status)
        ) {
          // This EXACT transactionId already has a permanent, webhook-
          // recorded terminal outcome -- this request's own "verified"
          // claim for it must never reopen it, regardless of signedDate
          // (see `isPermanentlyTerminalForSameTransaction`'s own doc
          // comment -- the real bug this closes).
          return {
            conflict: false as const,
            stale: true as const,
            currentStatus: asString(freshExisting.status) || 'expired',
          };
        }
        if (freshExisting && isStaleAppleResubmission(provider, freshExisting.payload, verified.signedDate)) {
          return {
            conflict: false as const,
            stale: true as const,
            currentStatus: asString(freshExisting.status) || 'expired',
          };
        }

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
        return { conflict: false as const, stale: false as const };
      },
    );
    if (outcome.conflict) {
      return ctx.forbidden('Bu satin alma farkli bir hesaba bagli.', {
        reasonCode: 'identity_conflict',
        correlationId,
      });
    }
    if (outcome.stale) {
      ctx.body = {
        verified: false,
        success: false,
        provider,
        productId,
        transactionId: finalTx,
        status: outcome.currentStatus,
        message: 'Islem artik gecerli degil.',
      };
      return;
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
    const expiresAt = asString(outcome.expiresAt) || undefined;

    // Review follow-up (webhook/verify-repair concurrency): same lock,
    // same key scheme (`tx:`/`tok:`) the interactive verify() path uses
    // for Google -- serializes this write against a concurrently in-
    // flight verify()/idempotent-repair for the SAME purchase token, and
    // re-reads `existing` fresh inside it so neither can act on a copy
    // the other has already superseded.
    await withPurchaseIdentityLock(
      [`tx:${asString(existing.transactionId)}`, `tok:${purchaseToken}`],
      async () => {
        const freshExisting = await findPurchaseEvent(strapi, { purchaseToken });
        if (!freshExisting) return;
        const tx = asString(freshExisting.transactionId);
        await upsertPurchaseEvent(strapi, {
          ...freshExisting,
          status,
          source: 'google_webhook',
          expiresAt: expiresAt ?? null,
          purchasedAt: asString(outcome.purchasedAt) || freshExisting.purchasedAt || null,
          payload: { ...asRecord(freshExisting.payload), googleWebhook: payload, googleStore: outcome.payload },
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
          ownerId: asString(freshExisting.ownerProfileId),
          categoryTitle: asString(freshExisting.categoryTitle),
          planTitle: asString(freshExisting.planTitle),
          priceTl: Number(freshExisting.priceTl ?? 0) || 0,
          provider: 'google_play',
          transactionId: tx,
          productId: asString(freshExisting.productId),
          premiumEndsAt: expiresAt,
          forcePremiumStatus: status,
          autoRenew: outcome.autoRenew,
          // purchaseToken is the stable identity of this subscription across
          // its whole lifetime for Google -- see the interactive verify()
          // call site's own comment on this same field.
          originalTransactionId: purchaseToken || undefined,
          purchasedAt: asString(outcome.purchasedAt) || undefined,
        });
      },
    );
    ctx.body = { ok: true, status, transactionId: asString(existing.transactionId) };
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
    const outerSignedDate = Number(decoded.signedDate ?? 0) || 0;
    const txSignedDate = Number(tx.signedDate ?? 0) || 0;

    // Review follow-up (webhook/verify-repair concurrency): this exact
    // lock -- same key scheme (`tx:`/`orig:`) as the interactive verify()
    // and idempotent-repair paths -- now serializes this write against
    // theirs for the SAME transaction identity. `existing` is re-read
    // FRESH inside it (never the copy fetched before acquiring the lock),
    // so a verify()/repair that is concurrently mid-flight for this same
    // transaction can never interleave between this read and this write.
    const webhookResult = await withPurchaseIdentityLock(
      [`tx:${asString(existing.transactionId)}`, originalTransactionId && `orig:${originalTransactionId}`].filter(
        Boolean,
      ) as string[],
      async () => {
        const freshExisting = await findPurchaseEvent(strapi, { transactionId: asString(existing.transactionId) });
        if (!freshExisting) return { skipped: true as const, reason: 'event bulunamadi' };

        // Duplicate / out-of-order protection -- OUTER envelope, re-
        // checked against the FRESH row.
        const lastSigned = Number(asRecord(freshExisting.payload).appleLastSignedDate ?? 0) || 0;
        if (outerSignedDate && outerSignedDate <= lastSigned) {
          return { skipped: true as const, reason: 'eski/tekrarlanan bildirim' };
        }

        // Review follow-up (same-subscription renewal ordering): the
        // OUTER check above only bounds the ENVELOPE's own signedDate --
        // it does not prove the INNER transaction snapshot (`tx`, decoded
        // separately above) actually describes the subscription's
        // current period. Guard on the inner signedDate too, re-checked
        // against the FRESH row; permissive when Apple does not include it.
        const lastTxSigned = Number(asRecord(freshExisting.payload).appleLastTransactionSignedDate ?? 0) || 0;
        if (txSignedDate && txSignedDate <= lastTxSigned) {
          return { skipped: true as const, reason: 'eski/tekrarlanan islem verisi' };
        }

        const productId = ALL_PRODUCTS.has(claimedProduct) ? claimedProduct : asString(freshExisting.productId);
        const tid = asString(freshExisting.transactionId);
        await upsertPurchaseEvent(strapi, {
          ...freshExisting,
          productId,
          status,
          source: 'apple_webhook',
          expiresAt: expiresAt ?? null,
          purchasedAt: purchasedAt ?? (freshExisting as Record<string, unknown>).purchasedAt ?? null,
          payload: {
            ...asRecord(freshExisting.payload),
            appleLastSignedDate: outerSignedDate || lastSigned,
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
          ownerId: asString(freshExisting.ownerProfileId),
          categoryTitle: asString(freshExisting.categoryTitle),
          planTitle: asString(freshExisting.planTitle),
          priceTl: Number(freshExisting.priceTl ?? 0) || 0,
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
        return { skipped: false as const, status, transactionId: tid };
      },
    );

    if (webhookResult.skipped) {
      return (ctx.body = { ok: true, skipped: true, reason: webhookResult.reason });
    }
    ctx.body = { ok: true, status: webhookResult.status, transactionId: webhookResult.transactionId };
  },
});
