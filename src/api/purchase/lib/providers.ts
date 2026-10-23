import crypto from 'crypto';
import { asString, parseIso, Provider, PurchaseStatus } from './catalog';
import { appleConfig, googleConfig, isSoftVerifyActive, trustedAppleRoots } from './config';
import { verifyAppleJws } from './apple-jws';

export type VerifyOutcome = {
  verified: boolean;
  status: PurchaseStatus;
  provider: Provider;
  transactionId?: string;
  originalTransactionId?: string;
  expiresAt?: string;
  /**
   * Review follow-up (real production symptom: an old, already-expired
   * transaction's history entry showed up dated TODAY instead of its real
   * purchase date): the store's own verified purchase-start time, when the
   * provider actually reports one (Apple's JWS `purchaseDate`, Google's
   * `startTime`/`purchaseTimeMillis`) -- distinct from WHEN our backend
   * happened to process this request, which can be much later (a redelivered/
   * restored transaction, a delayed webhook, a retried verify() on an
   * already-expired subscription). Never set for a rejection where no real
   * transaction was ever decoded.
   */
  purchasedAt?: string;
  /**
   * Review follow-up (stale-JWS resurrection guard): Apple's own
   * JWSTransactionDecodedPayload.signedDate for THIS exact transaction
   * snapshot -- the same field `appleWebhook` already tracks as
   * `appleLastTransactionSignedDate` to order renewals/notifications. A
   * client resubmitting an old, frozen (already-superseded) JWS always
   * carries its OLD signedDate forever, since the JWS itself cannot
   * change after Apple signs it -- so comparing this against the
   * backend's own already-known `appleLastTransactionSignedDate` is what
   * actually distinguishes a stale resubmission (older or equal) from a
   * genuine newer renewal (always a later signedDate), unlike re-
   * verifying the JWS's own signature/expiry alone, which only proves it
   * was validly signed at SOME point -- never that it reflects anything
   * more recent than whatever is already known. Apple only; Google's
   * verification is already a live Play Developer API call, so it has
   * no equivalent staleness problem.
   */
  signedDate?: number;
  purchaseToken?: string;
  payload?: unknown;
  /** Store-reported auto-renew state when known (false once the user cancelled). */
  autoRenew?: boolean;
  message: string;
  /**
   * Review follow-up (unverified-claim ownership lock): EXPLICITLY set at
   * each return below -- never inferred elsewhere from the mere presence
   * of `transactionId` or any other field. True only when BOTH of these
   * hold: (1) the receipt/token's own signature or the provider's own
   * API call genuinely authenticated it (never true for an empty
   * receipt/token, a bad JWS signature, or a provider-side HTTP/lookup
   * failure that never got a real answer), AND (2) the claimed identity
   * -- bundle id, product id -- actually matches what this specific
   * request asked for. A real, validly-signed Apple/Google transaction
   * sent against the WRONG bundle or product is deliberately false here:
   * it proves the sender holds *some* genuine receipt, never that they
   * own the specific product/transaction identity being claimed, so it
   * must never let the SENDER'S account win a permanent ownership lock
   * over that claimed identity. `verified: true` always implies this is
   * true; the reverse is not implied (a genuinely identified purchase
   * that is refunded/expired/not-yet-active is `identityAuthenticated:
   * true` with `verified: false`).
   */
  identityAuthenticated: boolean;
};

/** A 5xx / 429 from a store is transient: surface it as an error so callers retry
 * (never record it as a permanent "rejected" purchase). */
const failIfTransient = (res: Response, what: string) => {
  if (res.status >= 500 || res.status === 429) {
    throw new Error(`${what} geçici olarak kullanılamıyor (${res.status}).`);
  }
};


const signJwtRs256 = (
  payload: Record<string, unknown>,
  privateKey: string,
): string => {
  const header = { alg: 'RS256', typ: 'JWT' };
  const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url');
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    'base64url',
  );
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${encodedHeader}.${encodedPayload}`);
  signer.end();
  const sig = signer.sign(privateKey, 'base64url');
  return `${encodedHeader}.${encodedPayload}.${sig}`;
};

const getGoogleAccessToken = async (): Promise<string> => {
  const g = googleConfig();
  if (!g.packageName || !g.serviceAccountEmail || !g.serviceAccountPrivateKey) {
    throw new Error(
      'Google doğrulama env eksik (GOOGLE_PLAY_PACKAGE_NAME/GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY).',
    );
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const assertion = signJwtRs256(
    {
      iss: g.serviceAccountEmail,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: nowSec + 3600,
    },
    g.serviceAccountPrivateKey,
  );
  const form = new URLSearchParams();
  form.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  form.set('assertion', assertion);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(
      `Google token alınamadı (${res.status}): ${asString(
        body.error_description || body.error,
      )}`,
    );
  }
  const token = asString(body.access_token);
  if (!token) throw new Error('Google access_token boş.');
  return token;
};

export const verifyGoogle = async (input: {
  productId: string;
  purchaseToken: string;
  isSubscription: boolean;
}): Promise<VerifyOutcome> => {
  const purchaseToken = asString(input.purchaseToken);
  if (!purchaseToken) {
    return {
      verified: false,
      status: 'rejected',
      provider: 'google_play',
      message: 'Google purchase token boş.',
      identityAuthenticated: false,
    };
  }
  const accessToken = await getGoogleAccessToken();
  const GOOGLE_PACKAGE_NAME = googleConfig().packageName;

  if (input.isSubscription) {
    const url =
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
      `${encodeURIComponent(GOOGLE_PACKAGE_NAME)}/purchases/subscriptionsv2/tokens/` +
      `${encodeURIComponent(purchaseToken)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    failIfTransient(res, 'Google subscription verify');
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      // Google's own API never actually answered -- no genuine lookup
      // happened, so this is not an authenticated identity either.
      return {
        verified: false,
        status: 'rejected',
        provider: 'google_play',
        purchaseToken,
        payload: body,
        message: `Google subscription verify başarısız (${res.status}).`,
        identityAuthenticated: false,
      };
    }
    const lineItems = Array.isArray(body.lineItems) ? body.lineItems : [];
    // The purchased product must be EXACTLY the one being claimed. Falling back to
    // the first line item let a cheap subscription's token be presented as a more
    // expensive plan (product substitution).
    const matched = lineItems.find(
      (x) => asString((x as Record<string, unknown>).productId) === input.productId,
    ) as Record<string, unknown> | undefined;
    if (!matched) {
      // Review follow-up: Google genuinely answered for this token, but
      // NOT for the claimed product -- same reasoning as Apple's bundle/
      // product mismatch: a real token, the wrong product, never an
      // authenticated claim to the product being requested.
      return {
        verified: false,
        status: 'rejected',
        provider: 'google_play',
        purchaseToken,
        payload: body,
        message: 'Google aboneliği talep edilen ürünle eşleşmiyor.',
        identityAuthenticated: false,
      };
    }
    const exp = parseIso(asString(matched?.expiryTime));
    const startedAt = parseIso(asString((matched as Record<string, unknown> | undefined)?.startTime));
    const state = asString(body.subscriptionState).toUpperCase();
    let status: PurchaseStatus = 'verified';
    if (state.includes('EXPIRED')) status = 'expired';
    else if (state.includes('REVOKED')) status = 'refunded';
    else if (state.includes('ON_HOLD') || state.includes('PAUSED')) status = 'pending';
    else if (state.includes('CANCELED')) {
      status = exp && exp.getTime() > Date.now() ? 'verified' : 'canceled';
    }
    if (exp && exp.getTime() <= Date.now() && status === 'verified') status = 'expired';
    // Past this point: Google's own API genuinely identified this token
    // AND matched it to the exact requested product -- a real identity,
    // whatever its current entitlement state.
    return {
      verified: status === 'verified',
      status,
      provider: 'google_play',
      transactionId: asString(body.latestOrderId) || asString(body.orderId),
      originalTransactionId: asString(body.linkedPurchaseToken) || undefined,
      autoRenew: !state.includes('CANCELED') && status === 'verified',
      expiresAt: exp?.toISOString(),
      purchasedAt: startedAt?.toISOString(),
      purchaseToken,
      payload: body,
      message: status === 'verified' ? 'Google subscription doğrulandı.' : `Durum: ${status}`,
      identityAuthenticated: true,
    };
  }

  const url =
    `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
    `${encodeURIComponent(GOOGLE_PACKAGE_NAME)}/purchases/products/` +
    `${encodeURIComponent(input.productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  failIfTransient(res, 'Google product verify');
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    // Google's own API never actually answered for this token/product.
    return {
      verified: false,
      status: 'rejected',
      provider: 'google_play',
      purchaseToken,
      payload: body,
      message: `Google product verify başarısız (${res.status}).`,
      identityAuthenticated: false,
    };
  }
  // The request URL itself already scopes this lookup to the EXACT
  // requested product (unlike the subscription path, there is no
  // separate product-substitution check to make here) -- a genuine
  // answer from Google means a real, authenticated identity for this
  // product, regardless of its purchaseState.
  const purchaseState = Number(body.purchaseState ?? -1);
  const status: PurchaseStatus = purchaseState === 0 ? 'verified' : 'rejected';
  const oneTimePurchaseMs = Number(body.purchaseTimeMillis ?? 0) || 0;
  return {
    verified: status === 'verified',
    status,
    provider: 'google_play',
    transactionId: asString(body.orderId),
    purchasedAt: oneTimePurchaseMs > 0 ? new Date(oneTimePurchaseMs).toISOString() : undefined,
    purchaseToken,
    payload: body,
    message: status === 'verified' ? 'Google ürün doğrulandı.' : 'Google ürün reddedildi.',
    identityAuthenticated: true,
  };
};

/**
 * UAT #14 (real-device 1.0.85 report) root cause: this used to POST
 * `receipt` to Apple's LEGACY `/verifyReceipt` REST endpoint, expecting
 * the old base64 App Store receipt blob (StoreKit1's format). But the
 * Flutter app's `in_app_purchase_storekit` (0.4.8+1) defaults to
 * `_useStoreKit2 = true` (confirmed: nothing in this app's own code
 * overrides that) -- on StoreKit2, `PurchaseDetails.verificationData.
 * serverVerificationData` (what the app sends as `receipt`) is the
 * transaction's `jwsRepresentation`, a completely different format (a
 * signed JWS, not a base64 PKCS#7 blob). Apple's legacy endpoint cannot
 * parse a JWS as `receipt-data` -- every real purchase on a StoreKit2
 * device (the default for any current build) was verified against the
 * WRONG API and rejected, exactly matching "satın alma tamamlanmıyor".
 *
 * The App Store Server Notification webhook (`appleWebhook`, this same
 * file's sibling) already had the CORRECT verification for this exact
 * JWS shape (`verifyAppleJws`, root-pinned cert chain -- this is Apple's
 * own documented model for StoreKit2: a transaction JWS is
 * self-verifying, no server round trip to Apple needed at all). This
 * now uses that same, already-tested verifier instead of a network call
 * -- stronger (cryptographic chain verification pinned to Apple's real
 * root) than the old shared-secret REST call, never weaker.
 */
const verifyApple = async (input: {
  productId: string;
  receipt: string;
  isSubscription: boolean;
}): Promise<VerifyOutcome> => {
  const apple = appleConfig();
  if (!apple.bundleId) {
    throw new Error('APPLE_BUNDLE_ID tanımlı değil.');
  }
  const receipt = asString(input.receipt);
  if (!receipt) {
    return {
      verified: false,
      status: 'rejected',
      provider: 'app_store',
      message: 'Apple receipt boş.',
      identityAuthenticated: false,
    };
  }

  let tx: Record<string, unknown>;
  try {
    tx = verifyAppleJws(receipt, { trustedRootSha256: trustedAppleRoots() });
  } catch (e) {
    return {
      verified: false,
      status: 'rejected',
      provider: 'app_store',
      message: `Apple işlem doğrulaması başarısız: ${String((e as Error)?.message ?? e)}`,
      identityAuthenticated: false,
    };
  }

  // The transaction must belong to THIS app, not another app sharing product ids.
  // Review follow-up: the JWS signature itself is genuinely valid here, but
  // `identityAuthenticated: false` is deliberate -- a real transaction for a
  // DIFFERENT app's bundle must never let the sender claim ownership of
  // whatever transactionId THIS request happens to assert.
  if (asString(tx.bundleId) !== apple.bundleId) {
    return {
      verified: false,
      status: 'rejected',
      provider: 'app_store',
      payload: tx,
      message: 'Apple işlemi bu uygulamaya ait değil.',
      identityAuthenticated: false,
    };
  }

  // Product substitution guard: the JWS transaction's own claimed product
  // must match what the client says it's paying for -- never trust the
  // client's productId alone (mirrors the old code's equivalent filter).
  // Same reasoning as the bundle check above: genuinely signed, but for a
  // DIFFERENT product -- not authenticated as the claimed identity.
  const claimedProduct = asString(tx.productId);
  if (input.productId && claimedProduct && claimedProduct !== input.productId) {
    return {
      verified: false,
      status: 'rejected',
      provider: 'app_store',
      payload: tx,
      message: 'Apple işlemi talep edilen ürünle eşleşmiyor.',
      identityAuthenticated: false,
    };
  }

  const transactionId = asString(tx.transactionId);
  const originalTransactionId = asString(tx.originalTransactionId);
  const revoked = Number(tx.revocationDate ?? 0) > 0;
  const nowMs = Date.now();
  const purchaseMs = Number(tx.purchaseDate ?? 0) || 0;
  const purchasedAt = purchaseMs > 0 ? new Date(purchaseMs).toISOString() : undefined;
  const signedDate = Number(tx.signedDate ?? 0) || 0;

  // From here on: signature verified, bundle matches, product matches --
  // this genuinely IS the transaction identity it claims to be, whatever
  // its current entitlement state (refunded/expired/active) turns out to
  // be below.
  if (input.isSubscription) {
    if (revoked) {
      return {
        verified: false,
        status: 'refunded',
        provider: 'app_store',
        transactionId,
        originalTransactionId,
        purchasedAt,
        signedDate: signedDate || undefined,
        payload: tx,
        message: 'Apple aboneliği iade/iptal edilmiş.',
        identityAuthenticated: true,
      };
    }
    const expiresMs = Number(tx.expiresDate ?? 0) || 0;
    const isActive = Number.isFinite(expiresMs) && expiresMs > nowMs;
    return {
      verified: isActive,
      status: isActive ? 'verified' : 'expired',
      provider: 'app_store',
      transactionId,
      originalTransactionId,
      expiresAt: expiresMs > 0 ? new Date(expiresMs).toISOString() : undefined,
      purchasedAt,
      signedDate: signedDate || undefined,
      payload: tx,
      message: isActive ? 'Apple abonelik doğrulandı.' : 'Apple abonelik süresi dolmuş.',
      identityAuthenticated: true,
    };
  }

  // One-time (non-consumable/consumable) product: a single transaction JWS,
  // valid unless the store has since revoked/refunded it.
  return {
    verified: !revoked,
    status: revoked ? 'refunded' : 'verified',
    provider: 'app_store',
    transactionId,
    originalTransactionId,
    purchasedAt,
    signedDate: signedDate || undefined,
    payload: tx,
    message: revoked ? 'Apple ürün iade edilmiş.' : 'Apple ürün doğrulandı.',
    identityAuthenticated: true,
  };
};

export const verifyWithProvider = async (input: {
  provider: Provider;
  productId: string;
  receipt: string;
  purchaseToken: string;
  isSubscription: boolean;
  fallbackTransactionId: string;
}): Promise<VerifyOutcome> => {
  if (isSoftVerifyActive()) {
    // Dev/test-only unconditional trust bypass (never reachable outside
    // development/test -- see `isSoftVerifyRefused`'s own enforcement).
    // `verified: true` already implies `identityAuthenticated: true`
    // everywhere else in this file; kept consistent here too.
    return {
      verified: true,
      status: 'verified',
      provider: input.provider,
      transactionId: input.fallbackTransactionId,
      purchaseToken: input.purchaseToken || undefined,
      message: 'Soft verify aktif.',
      identityAuthenticated: true,
    };
  }
  return input.provider === 'google_play'
    ? verifyGoogle({
        productId: input.productId,
        purchaseToken: input.purchaseToken || input.receipt,
        isSubscription: input.isSubscription,
      })
    : verifyApple({
        productId: input.productId,
        receipt: input.receipt,
        isSubscription: input.isSubscription,
      });
};
