import crypto from 'crypto';

/**
 * Authenticates a Google Cloud Pub/Sub PUSH request. With authentication enabled
 * on the push subscription, Pub/Sub sends `Authorization: Bearer <OIDC JWT>`
 * signed by Google for the subscription's service account. We verify:
 *  - RS256 signature against Google's published keys (kid -> JWK);
 *  - iss is Google; aud equals OUR configured audience;
 *  - email equals the configured push service account and email_verified is true;
 *  - the token is not expired.
 */
export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

type Jwk = crypto.JsonWebKey & { kid?: string };
let jwksCache: { keys: Jwk[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

export const resetGoogleJwksCache = () => {
  jwksCache = null;
};

const loadJwks = async (force: boolean): Promise<Jwk[]> => {
  if (!force && jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetch(GOOGLE_CERTS_URL);
  if (!res.ok) throw new Error(`Google sertifikaları alınamadı (${res.status}).`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache = { keys, fetchedAt: Date.now() };
  return keys;
};

export type OidcResult = { ok: true } | { ok: false; reason: string };

export const verifyPubSubOidc = async (
  authorizationHeader: string,
  expected: { audience: string; serviceAccountEmail: string },
): Promise<OidcResult> => {
  if (!expected.audience || !expected.serviceAccountEmail) {
    return { ok: false, reason: 'Pub/Sub kimlik doğrulaması yapılandırılmamış.' };
  }
  const auth = String(authorizationHeader ?? '').trim();
  if (!auth.toLowerCase().startsWith('bearer ')) return { ok: false, reason: 'Bearer token yok.' };
  const token = auth.slice(7).trim();
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'Token biçimi geçersiz.' };

  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'Token çözülemedi.' };
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
    return { ok: false, reason: 'Token alg/kid geçersiz.' };
  }

  let jwk: Jwk | undefined;
  try {
    jwk = (await loadJwks(false)).find((k) => k.kid === header.kid);
    if (!jwk) jwk = (await loadJwks(true)).find((k) => k.kid === header.kid);
  } catch (e) {
    return { ok: false, reason: String(e) };
  }
  if (!jwk) return { ok: false, reason: 'Token anahtarı bilinmiyor.' };

  let valid = false;
  try {
    valid = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      crypto.createPublicKey({ key: jwk, format: 'jwk' }),
      Buffer.from(parts[2], 'base64url'),
    );
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: 'Token imzası geçersiz.' };

  const nowSec = Math.floor(Date.now() / 1000);
  const iss = String(claims.iss ?? '');
  if (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') {
    return { ok: false, reason: 'Token issuer geçersiz.' };
  }
  if (String(claims.aud ?? '') !== expected.audience) return { ok: false, reason: 'Token audience geçersiz.' };
  if (!(Number(claims.exp) > nowSec - 30)) return { ok: false, reason: 'Token süresi dolmuş.' };
  if (String(claims.email ?? '').toLowerCase() !== expected.serviceAccountEmail.toLowerCase()) {
    return { ok: false, reason: 'Token service account geçersiz.' };
  }
  if (claims.email_verified !== true) return { ok: false, reason: 'Token e-postası doğrulanmamış.' };
  return { ok: true };
};
