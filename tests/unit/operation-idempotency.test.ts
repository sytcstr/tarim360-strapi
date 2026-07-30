/**
 * Unit tests for src/utils/operation-idempotency.ts — pure logic plus a
 * minimal in-memory fake of the one Strapi call resolveOperation makes
 * (db.query(uid).findOne), so this runs with no real Strapi boot / DB
 * connection. Run with:
 *   node --test tests/unit/operation-idempotency.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fingerprintPayload,
  isValidOperationId,
  resolveOperation,
} from '../../src/utils/operation-idempotency.ts';

test('isValidOperationId accepts a well-formed UUID (any case)', () => {
  assert.equal(isValidOperationId('550e8400-e29b-41d4-a716-446655440000'), true);
  assert.equal(isValidOperationId('550E8400-E29B-41D4-A716-446655440000'), true);
});

test('isValidOperationId rejects anything not shaped like a UUID', () => {
  assert.equal(isValidOperationId(''), false);
  assert.equal(isValidOperationId('not-a-uuid'), false);
  assert.equal(isValidOperationId('550e8400e29b41d4a716446655440000'), false); // no dashes
  assert.equal(isValidOperationId(12345), false);
  assert.equal(isValidOperationId(undefined), false);
});

test('fingerprintPayload is deterministic regardless of key order', () => {
  const a = fingerprintPayload({ listingId: '123', channel: 'whatsapp', ownerId: 'u_1' });
  const b = fingerprintPayload({ ownerId: 'u_1', listingId: '123', channel: 'whatsapp' });
  assert.equal(a, b);
});

test('fingerprintPayload differs when a meaningful field differs', () => {
  const a = fingerprintPayload({ listingId: '123', channel: 'whatsapp' });
  const b = fingerprintPayload({ listingId: '123', channel: 'sms' });
  assert.notEqual(a, b);
});

/** Minimal fake of strapi.db.query(uid).findOne({where:{operationId}}) —
 * enough to exercise resolveOperation's three branches without a real DB. */
const fakeStrapi = (rows: Record<string, any>[]) => ({
  db: {
    query: (_uid: string) => ({
      findOne: async ({ where }: { where: { operationId: string } }) =>
        rows.find((r) => r.operationId === where.operationId) ?? null,
    }),
  },
});

test('resolveOperation returns "new" when no row exists for this operationId', async () => {
  const strapi = fakeStrapi([]);
  const result = await resolveOperation(strapi, 'api::listing-comment.listing-comment', 'op-1', 'fp-1');
  assert.deepEqual(result, { status: 'new' });
});

test('resolveOperation returns "duplicate" when the same operationId AND fingerprint retry', async () => {
  const existing = { id: 1, operationId: 'op-1', payloadFingerprint: 'fp-1' };
  const strapi = fakeStrapi([existing]);
  const result = await resolveOperation(strapi, 'api::listing-comment.listing-comment', 'op-1', 'fp-1');
  assert.equal(result.status, 'duplicate');
  assert.equal((result as any).existing, existing);
});

test('resolveOperation returns "conflict" when the same operationId arrives with a DIFFERENT fingerprint', async () => {
  const existing = { id: 1, operationId: 'op-1', payloadFingerprint: 'fp-1' };
  const strapi = fakeStrapi([existing]);
  const result = await resolveOperation(strapi, 'api::listing-comment.listing-comment', 'op-1', 'fp-DIFFERENT');
  assert.deepEqual(result, { status: 'conflict' });
});
