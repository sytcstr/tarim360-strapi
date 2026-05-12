const crypto = require('node:crypto');

const FCM_LEGACY_ENDPOINT = 'https://fcm.googleapis.com/fcm/send';
const OAUTH_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const FCM_ANDROID_CHANNEL_ID = 'tarim360_general';

export type SendPushInput = {
  tokens: string[];
  title: string;
  body: string;
  data?: Record<string, unknown>;
};

export type SendPushResult = {
  attempted: number;
  success: number;
  invalidTokens: string[];
  skipped: boolean;
  reason?: string;
};

const normalizeToken = (value: unknown): string => String(value ?? '').trim();

const unwrapQuotedEnv = (value: string): string => {
  const text = value.trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.substring(1, text.length - 1).trim();
  }
  return text;
};

const parseJsonArrayFromString = (value: string): string[] => {
  const text = value.trim();
  if (!text.startsWith('[') || !text.endsWith(']')) return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => normalizeToken(item)).filter((item) => item.length >= 20);
  } catch (_) {
    return [];
  }
};

const splitByComma = (value: string): string[] => {
  if (!value.includes(',')) return [];
  return value
    .split(',')
    .map((part) => normalizeToken(part))
    .filter((part) => part.length >= 20);
};

export const normalizeFcmTokenList = (raw: unknown): string[] => {
  const bag = new Set<string>();

  const append = (value: unknown) => {
    const token = normalizeToken(value);
    if (token.length < 20) return;
    bag.add(token);
  };

  const visit = (value: unknown) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === 'string') {
      const parsedJson = parseJsonArrayFromString(value);
      if (parsedJson.length > 0) {
        for (const token of parsedJson) append(token);
        return;
      }
      const parsedComma = splitByComma(value);
      if (parsedComma.length > 0) {
        for (const token of parsedComma) append(token);
        return;
      }
      append(value);
      return;
    }
    append(value);
  };

  visit(raw);
  return [...bag];
};

const chunkArray = <T>(arr: T[], size: number): T[][] => {
  if (arr.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
};

const base64UrlEncode = (input: string | Buffer) =>
  Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');

const firebaseProjectId = (): string =>
  unwrapQuotedEnv(normalizeToken(process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT_ID));

const firebaseClientEmail = (): string =>
  unwrapQuotedEnv(normalizeToken(process.env.FIREBASE_CLIENT_EMAIL || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL));

const firebasePrivateKey = (): string =>
  unwrapQuotedEnv(
    normalizeToken(process.env.FIREBASE_PRIVATE_KEY || process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY),
  ).replace(/\\n/g, '\n');

let accessTokenCache = {
  token: '',
  expiresAt: 0,
};

const canUseHttpV1 = (): boolean =>
  firebaseProjectId().length > 0 &&
  firebaseClientEmail().length > 0 &&
  firebasePrivateKey().length > 0;

const buildServiceAccountJwt = (): string => {
  const clientEmail = firebaseClientEmail();
  const privateKey = firebasePrivateKey();
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claimSet = {
    iss: clientEmail,
    scope: FCM_SCOPE,
    aud: OAUTH_TOKEN_ENDPOINT,
    iat: now,
    exp: now + 3600,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaims = base64UrlEncode(JSON.stringify(claimSet));
  const unsigned = `${encodedHeader}.${encodedClaims}`;

  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKey);
  return `${unsigned}.${base64UrlEncode(signature)}`;
};

const fetchAccessToken = async (): Promise<string> => {
  const now = Date.now();
  if (accessTokenCache.token && accessTokenCache.expiresAt > now + 60_000) {
    return accessTokenCache.token;
  }

  const assertion = buildServiceAccountJwt();
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  });

  const response = await fetch(OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`FCM OAuth failed (${response.status}): ${text}`);
  }

  const payload = JSON.parse(text);
  const token = normalizeToken(payload.access_token);
  const expiresIn = Number(payload.expires_in ?? 3600);
  if (!token) throw new Error('FCM OAuth returned empty access_token');

  accessTokenCache = {
    token,
    expiresAt: now + Math.max(300, expiresIn - 120) * 1000,
  };
  return token;
};

const isInvalidTokenResponse = (text: string): boolean => {
  const normalized = text.toUpperCase();
  return (
    normalized.includes('UNREGISTERED') ||
    normalized.includes('INVALID_ARGUMENT') ||
    normalized.includes('INVALID_REGISTRATION') ||
    normalized.includes('NOT_FOUND')
  );
};

const sendViaHttpV1 = async (input: SendPushInput): Promise<SendPushResult> => {
  const projectId = firebaseProjectId();
  const tokens = normalizeFcmTokenList(input.tokens);
  if (tokens.length === 0) {
    return {
      attempted: 0,
      success: 0,
      invalidTokens: [],
      skipped: true,
      reason: 'empty token list',
    };
  }

  const title = normalizeToken(input.title) || 'Tarim360';
  const body = normalizeToken(input.body) || 'Yeni bildirim';
  const data = {};
  if (input.data && typeof input.data === 'object') {
    for (const [key, value] of Object.entries(input.data)) {
      const k = normalizeToken(key);
      const v = normalizeToken(value);
      if (!k || !v) continue;
      data[k] = v;
    }
  }

  let attempted = 0;
  let success = 0;
  const invalidBag = new Set<string>();
  const accessToken = await fetchAccessToken();
  const endpoint = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

  for (const token of tokens) {
    attempted += 1;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          notification: {
            title,
            body,
          },
          data,
          android: {
            priority: 'HIGH',
            notification: {
              channel_id: FCM_ANDROID_CHANNEL_ID,
              sound: 'default',
            },
          },
          apns: {
            headers: {
              'apns-priority': '10',
            },
            payload: {
              aps: {
                sound: 'default',
              },
            },
          },
        },
      }),
    });

    if (response.ok) {
      success += 1;
      continue;
    }

    const text = await response.text();
    if (isInvalidTokenResponse(text)) {
      invalidBag.add(token);
      continue;
    }

    throw new Error(`FCM v1 request failed (${response.status}): ${text}`);
  }

  return {
    attempted,
    success,
    invalidTokens: [...invalidBag],
    skipped: false,
  };
};

const sendViaLegacy = async (input: SendPushInput): Promise<SendPushResult> => {
  const serverKey = normalizeToken(process.env.FCM_SERVER_KEY);
  if (!serverKey) {
    return {
      attempted: 0,
      success: 0,
      invalidTokens: [],
      skipped: true,
      reason: 'FCM_SERVER_KEY missing',
    };
  }

  const tokens = normalizeFcmTokenList(input.tokens);
  if (tokens.length === 0) {
    return {
      attempted: 0,
      success: 0,
      invalidTokens: [],
      skipped: true,
      reason: 'empty token list',
    };
  }

  const title = normalizeToken(input.title) || 'Tarim360';
  const body = normalizeToken(input.body) || 'Yeni bildirim';
  const data = {};
  if (input.data && typeof input.data === 'object') {
    for (const [key, value] of Object.entries(input.data)) {
      const k = normalizeToken(key);
      if (!k) continue;
      const v = normalizeToken(value);
      if (!v) continue;
      data[k] = v;
    }
  }

  let attempted = 0;
  let success = 0;
  const invalidBag = new Set<string>();
  const chunks = chunkArray(tokens, 500);

  for (const chunk of chunks) {
    attempted += chunk.length;
    const response = await fetch(FCM_LEGACY_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `key=${serverKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        registration_ids: chunk,
        priority: 'high',
        notification: {
          title,
          body,
          sound: 'default',
          android_channel_id: FCM_ANDROID_CHANNEL_ID,
        },
        data,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`FCM request failed (${response.status}): ${text}`);
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const successCount = Number(payload.success ?? 0);
    if (Number.isFinite(successCount) && successCount > 0) {
      success += successCount;
    }

    const results = Array.isArray(payload.results) ? payload.results : [];
    for (let i = 0; i < results.length; i++) {
      const row = results[i];
      if (!row || typeof row !== 'object') continue;
      const error = normalizeToken(row.error);
      if (!error) continue;
      if (error === 'InvalidRegistration' || error === 'NotRegistered') {
        const token = chunk[i];
        if (token) invalidBag.add(token);
      }
    }
  }

  return {
    attempted,
    success,
    invalidTokens: [...invalidBag],
    skipped: false,
  };
};

export const sendFcmLegacyPush = async (
  input: SendPushInput,
): Promise<SendPushResult> => {
  if (canUseHttpV1()) {
    return sendViaHttpV1(input);
  }
  return sendViaLegacy(input);
};


