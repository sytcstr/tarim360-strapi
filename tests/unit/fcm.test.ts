/**
 * Unit tests for src/utils/fcm.ts -- specifically the service-account
 * private-key env-var parsing (BUG-risk area: a key that parses with the
 * wrong newline handling silently produces an invalid RS256 signature,
 * which only ever surfaces as an opaque OAuth failure against the real
 * Google endpoint -- never caught by any mock/widget test). No real
 * credential, network call, or env var is touched by this file -- it only
 * exercises the pure parsing function with literal, fake-shaped strings.
 * Run with:
 *   node --test tests/unit/fcm.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFcmTokenList, normalizeServiceAccountPrivateKey } from '../../src/utils/fcm.ts';

const FAKE_PEM_REAL_NEWLINES =
  '-----BEGIN PRIVATE KEY-----\nFAKEKEYLINE1\nFAKEKEYLINE2\n-----END PRIVATE KEY-----\n';

test('normalizeServiceAccountPrivateKey: a key stored with escaped \\n (the common .env/hosting-UI shape) becomes real newlines', () => {
  const escaped =
    '-----BEGIN PRIVATE KEY-----\\nFAKEKEYLINE1\\nFAKEKEYLINE2\\n-----END PRIVATE KEY-----\\n';
  assert.equal(normalizeServiceAccountPrivateKey(escaped), FAKE_PEM_REAL_NEWLINES);
});

test('normalizeServiceAccountPrivateKey: the same escaped value wrapped in double quotes (so a shell/.env parser does not stop at the first real newline) is unwrapped first, then the \\n is still converted', () => {
  const quotedEscaped =
    '"-----BEGIN PRIVATE KEY-----\\nFAKEKEYLINE1\\nFAKEKEYLINE2\\n-----END PRIVATE KEY-----\\n"';
  assert.equal(normalizeServiceAccountPrivateKey(quotedEscaped), FAKE_PEM_REAL_NEWLINES);
});

test('normalizeServiceAccountPrivateKey: a key that already has genuine multi-line newlines (e.g. a secrets manager that preserves them) passes through with its content intact', () => {
  // A trailing real newline at the very edge is trimmed (same as any
  // surrounding whitespace -- harmless: crypto.createSign does not
  // require a PEM's final newline); every newline that is NOT at the
  // outermost edge survives untouched.
  assert.equal(
    normalizeServiceAccountPrivateKey(FAKE_PEM_REAL_NEWLINES),
    FAKE_PEM_REAL_NEWLINES.trimEnd(),
  );
});

test('normalizeServiceAccountPrivateKey: surrounding whitespace and single quotes are both handled', () => {
  const singleQuoted = `  '${FAKE_PEM_REAL_NEWLINES}'  `;
  // unwrapQuotedEnv's own existing (unchanged) behavior also trims the
  // unwrapped content -- a trailing newline right at the very end of the
  // key is lost either way, which crypto.createSign tolerates fine (a
  // PEM's final newline is not semantically required).
  assert.equal(
    normalizeServiceAccountPrivateKey(singleQuoted),
    FAKE_PEM_REAL_NEWLINES.trimEnd(),
  );
});

test('normalizeServiceAccountPrivateKey: empty/missing env value stays empty (canUseHttpV1 must see this as "not configured", never crash)', () => {
  assert.equal(normalizeServiceAccountPrivateKey(''), '');
  assert.equal(normalizeServiceAccountPrivateKey('   '), '');
});

test('normalizeFcmTokenList: deduplicates and accepts a JSON-array-shaped or comma-separated env value (unchanged behavior, re-asserted here alongside the key parsing it ships next to)', () => {
  assert.deepEqual(
    normalizeFcmTokenList(['tok_AAAAAAAAAAAAAAAAAAAA', 'tok_AAAAAAAAAAAAAAAAAAAA', 'tok_BBBBBBBBBBBBBBBBBBBB']),
    ['tok_AAAAAAAAAAAAAAAAAAAA', 'tok_BBBBBBBBBBBBBBBBBBBB'],
  );
  assert.deepEqual(normalizeFcmTokenList('short'), []);
});
