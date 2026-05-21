import crypto from 'crypto';
import {
  asString,
  parseIso,
  Provider,
  PurchaseStatus,
  parseBool,
} from './catalog';

export type VerifyOutcome = {
  verified: boolean;
  status: PurchaseStatus;
  provider: Provider;
  transactionId?: string;
  originalTransactionId?: string;
  expiresAt?: string;
  purchaseToken?: string;
  payload?: unknown;
  message: string;
};

const VERIFY_SOFT_MODE = parseBool(process.env.PURCHASE_VERIFY_SOFT, false);
const GOOGLE_PACKAGE_NAME = asString(process.env.GOOGLE_PLAY_PACKAGE_NAME);
const GOOGLE_SA_EMAIL = asString(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL);
const GOOGLE_SA_PRIVATE_KEY = asString(
  process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
).replace(/\\n/g, '\n');
const APPLE_SHARED_SECRET = asString(process.env.APPLE_SHARED_SECRET);

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
  if (!GOOGLE_PACKAGE_NAME || !GOOGLE_SA_EMAIL || !GOOGLE_SA_PRIVATE_KEY) {
    throw new Error(
      'Google doğrulama env eksik (GOOGLE_PLAY_PACKAGE_NAME/GOOGLE_SERVICE_ACCOUNT_EMAIL/GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY).',
    );
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const assertion = signJwtRs256(
    {
      iss: GOOGLE_SA_EMAIL,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: nowSec + 3600,
    },
    GOOGLE_SA_PRIVATE_KEY,
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

const verifyGoogle = async (input: {
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
    };
  }
  const accessToken = await getGoogleAccessToken();

  if (input.isSubscription) {
    const url =
      `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/` +
      `${encodeURIComponent(GOOGLE_PACKAGE_NAME)}/purchases/subscriptionsv2/tokens/` +
      `${encodeURIComponent(purchaseToken)}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        verified: false,
        status: 'rejected',
        provider: 'google_play',
        purchaseToken,
        payload: body,
        message: `Google subscription verify başarısız (${res.status}).`,
      };
    }
    const lineItems = Array.isArray(body.lineItems) ? body.lineItems : [];
    const matched =
      (lineItems.find(
        (x) => asString((x as Record<string, unknown>).productId) === input.productId,
      ) as Record<string, unknown> | undefined) ||
      (lineItems[0] as Record<string, unknown> | undefined);
    const exp = parseIso(asString(matched?.expiryTime));
    const state = asString(body.subscriptionState).toUpperCase();
    let status: PurchaseStatus = 'verified';
    if (state.includes('EXPIRED')) status = 'expired';
    else if (state.includes('REVOKED')) status = 'refunded';
    else if (state.includes('ON_HOLD') || state.includes('PAUSED')) status = 'pending';
    else if (state.includes('CANCELED')) {
      status = exp && exp.getTime() > Date.now() ? 'verified' : 'canceled';
    }
    if (exp && exp.getTime() <= Date.now() && status === 'verified') status = 'expired';
    return {
      verified: status === 'verified',
      status,
      provider: 'google_play',
      transactionId: asString(body.latestOrderId) || asString(body.orderId),
      originalTransactionId: asString(body.linkedPurchaseToken) || undefined,
      expiresAt: exp?.toISOString(),
      purchaseToken,
      payload: body,
      message: status === 'verified' ? 'Google subscription doğrulandı.' : `Durum: ${status}`,
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
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    return {
      verified: false,
      status: 'rejected',
      provider: 'google_play',
      purchaseToken,
      payload: body,
      message: `Google product verify başarısız (${res.status}).`,
    };
  }
  const purchaseState = Number(body.purchaseState ?? -1);
  const status: PurchaseStatus = purchaseState === 0 ? 'verified' : 'rejected';
  return {
    verified: status === 'verified',
    status,
    provider: 'google_play',
    transactionId: asString(body.orderId),
    purchaseToken,
    payload: body,
    message: status === 'verified' ? 'Google ürün doğrulandı.' : 'Google ürün reddedildi.',
  };
};

const callAppleVerifyReceipt = async (
  receipt: string,
  sandbox: boolean,
): Promise<Record<string, unknown>> => {
  const endpoint = sandbox
    ? 'https://sandbox.itunes.apple.com/verifyReceipt'
    : 'https://buy.itunes.apple.com/verifyReceipt';
  const body: Record<string, unknown> = {
    'receipt-data': receipt,
    'exclude-old-transactions': true,
  };
  if (APPLE_SHARED_SECRET) {
    body.password = APPLE_SHARED_SECRET;
  }
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Apple verifyReceipt HTTP ${res.status}`);
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
};

const verifyApple = async (input: {
  productId: string;
  receipt: string;
  isSubscription: boolean;
}): Promise<VerifyOutcome> => {
  if (input.isSubscription && !APPLE_SHARED_SECRET) {
    throw new Error('APPLE_SHARED_SECRET tanımlı değil.');
  }
  const receipt = asString(input.receipt);
  if (!receipt) {
    return {
      verified: false,
      status: 'rejected',
      provider: 'app_store',
      message: 'Apple receipt boş.',
    };
  }

  let body = await callAppleVerifyReceipt(receipt, false);
  if (Number(body.status ?? -1) === 21007) {
    body = await callAppleVerifyReceipt(receipt, true);
  }
  if (Number(body.status ?? -1) !== 0) {
    return {
      verified: false,
      status: 'rejected',
      provider: 'app_store',
      payload: body,
      message: `Apple verify status=${asString(body.status)}`,
    };
  }

  const nowMs = Date.now();
  if (input.isSubscription) {
    const latest = Array.isArray(body.latest_receipt_info) ? body.latest_receipt_info : [];
    const matched = latest
      .map((x) => x as Record<string, unknown>)
      .filter((x) => asString(x.product_id) === input.productId || !input.productId)
      .sort(
        (a, b) =>
          Number(asString(b.expires_date_ms) || '0') -
          Number(asString(a.expires_date_ms) || '0'),
      )[0];
    if (!matched) {
      return {
        verified: false,
        status: 'rejected',
        provider: 'app_store',
        payload: body,
        message: 'Apple abonelik kaydı bulunamadı.',
      };
    }
    const expiresMs = Number(asString(matched.expires_date_ms) || '0');
    const isActive = Number.isFinite(expiresMs) && expiresMs > nowMs;
    return {
      verified: isActive,
      status: isActive ? 'verified' : 'expired',
      provider: 'app_store',
      transactionId: asString(matched.transaction_id),
      originalTransactionId: asString(matched.original_transaction_id),
      expiresAt: Number.isFinite(expiresMs) && expiresMs > 0 ? new Date(expiresMs).toISOString() : undefined,
      payload: body,
      message: isActive ? 'Apple abonelik doğrulandı.' : 'Apple abonelik süresi dolmuş.',
    };
  }

  const receiptObj =
    body.receipt && typeof body.receipt === 'object'
      ? (body.receipt as Record<string, unknown>)
      : {};
  const inApp = Array.isArray(receiptObj.in_app) ? receiptObj.in_app : [];
  const matched = inApp
    .map((x) => x as Record<string, unknown>)
    .find((x) => asString(x.product_id) === input.productId || !input.productId);
  if (!matched) {
    return {
      verified: false,
      status: 'rejected',
      provider: 'app_store',
      payload: body,
      message: 'Apple ürün kaydı bulunamadı.',
    };
  }
  const canceled = asString(matched.cancellation_date).length > 0;
  return {
    verified: !canceled,
    status: canceled ? 'refunded' : 'verified',
    provider: 'app_store',
    transactionId: asString(matched.transaction_id),
    originalTransactionId: asString(matched.original_transaction_id),
    payload: body,
    message: canceled ? 'Apple ürün iade edilmiş.' : 'Apple ürün doğrulandı.',
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
  if (VERIFY_SOFT_MODE) {
    return {
      verified: true,
      status: 'verified',
      provider: input.provider,
      transactionId: input.fallbackTransactionId,
      purchaseToken: input.purchaseToken || undefined,
      message: 'Soft verify aktif.',
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
