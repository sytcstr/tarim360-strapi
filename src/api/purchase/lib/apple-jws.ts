import crypto from 'crypto';

/**
 * Verifies an App Store Server (Notifications V2 / signed transaction) JWS
 * according to Apple's specification:
 *  - alg must be ES256 and the header must carry an x5c chain (leaf, intermediate, root);
 *  - every certificate must be valid at `effectiveDate`;
 *  - leaf is signed by the intermediate, the intermediate by the root, and the
 *    root is one of the PINNED Apple roots (matched by SHA-256 fingerprint) and self-signed;
 *  - the JWS signature (raw R||S, ES256) verifies with the leaf certificate's key.
 * Returns the decoded payload only when all of that holds; otherwise throws.
 */
export class AppleJwsError extends Error {}

const b64urlToBuf = (s: string) => Buffer.from(s, 'base64url');

const fingerprintOf = (cert: crypto.X509Certificate) =>
  cert.fingerprint256.replace(/[^0-9a-fA-F]/g, '').toUpperCase();

export const verifyAppleJws = (
  jws: string,
  opts: { trustedRootSha256: string[]; effectiveDate?: Date },
): Record<string, unknown> => {
  const parts = String(jws ?? '').split('.');
  if (parts.length !== 3) throw new AppleJwsError('JWS biçimi geçersiz.');
  const [h, p, s] = parts;

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(b64urlToBuf(h).toString('utf8'));
  } catch {
    throw new AppleJwsError('JWS header çözülemedi.');
  }
  if (header.alg !== 'ES256') throw new AppleJwsError('JWS alg ES256 değil.');
  const x5c = Array.isArray(header.x5c) ? (header.x5c as unknown[]) : [];
  if (x5c.length < 3 || x5c.some((c) => typeof c !== 'string')) {
    throw new AppleJwsError('JWS x5c zinciri eksik.');
  }

  let certs: crypto.X509Certificate[];
  try {
    certs = (x5c as string[]).map((c) => new crypto.X509Certificate(Buffer.from(c, 'base64')));
  } catch {
    throw new AppleJwsError('x5c sertifikası çözülemedi.');
  }
  const [leaf, intermediate] = certs;
  const root = certs[certs.length - 1];

  const at = opts.effectiveDate ?? new Date();
  for (const c of certs) {
    if (at < new Date(c.validFrom) || at > new Date(c.validTo)) {
      throw new AppleJwsError('Sertifika geçerlilik süresi dışında.');
    }
  }
  // Chain: each certificate signed by the next; the last is the pinned, self-signed root.
  for (let i = 0; i < certs.length - 1; i++) {
    if (!certs[i].verify(certs[i + 1].publicKey)) {
      throw new AppleJwsError('Sertifika zinciri doğrulanamadı.');
    }
  }
  if (!root.verify(root.publicKey)) throw new AppleJwsError('Kök sertifika kendinden imzalı değil.');
  if (!opts.trustedRootSha256.includes(fingerprintOf(root))) {
    throw new AppleJwsError('Kök sertifika güvenilir Apple kökü değil.');
  }
  if (!leaf || !intermediate) throw new AppleJwsError('Sertifika zinciri eksik.');

  const ok = crypto.verify(
    'sha256',
    Buffer.from(`${h}.${p}`),
    { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' },
    b64urlToBuf(s),
  );
  if (!ok) throw new AppleJwsError('JWS imzası geçersiz.');

  try {
    return JSON.parse(b64urlToBuf(p).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new AppleJwsError('JWS payload çözülemedi.');
  }
};
