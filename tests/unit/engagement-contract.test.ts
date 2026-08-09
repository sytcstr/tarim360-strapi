/**
 * Unit tests for src/utils/engagement-contract.ts — pure logic, no
 * Strapi boot / no DB connection required. Run with:
 *   node --test tests/unit/engagement-contract.test.ts
 * (Node's native TypeScript support, v22.6+/v23+, strips types without a
 * build step — confirmed working against this repo's Node version.)
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertEngagementSupported,
  buildErrorBody,
  buildToggleBody,
  buildViewBody,
  CONTRACT_VERSION,
  DOMAIN_SUPPORT,
  isEngagementTargetType,
  resolveActorKey,
} from '../../src/utils/engagement-contract.ts';

test('isEngagementTargetType accepts only known target types', () => {
  assert.equal(isEngagementTargetType('listing'), true);
  assert.equal(isEngagementTargetType('logistics-load'), true);
  assert.equal(isEngagementTargetType('not-a-real-domain'), false);
  assert.equal(isEngagementTargetType(42), false);
  assert.equal(isEngagementTargetType(undefined), false);
});

test('DOMAIN_SUPPORT matrix matches ENGAGEMENT_API_CONTRACT.md §4.6', () => {
  assert.equal(DOMAIN_SUPPORT.listing.like, true);
  assert.equal(DOMAIN_SUPPORT.listing.favorite, true);
  assert.equal(DOMAIN_SUPPORT.listing.view, true);
  assert.equal(DOMAIN_SUPPORT.listing.comment, true);
  assert.equal(DOMAIN_SUPPORT.listing.share, true);

  assert.equal(DOMAIN_SUPPORT['logistics-vehicle'].like, false);
  assert.equal(DOMAIN_SUPPORT['logistics-vehicle'].favorite, true);
  assert.equal(DOMAIN_SUPPORT['logistics-vehicle'].view, true);

  assert.equal(DOMAIN_SUPPORT.ad.favorite, false);
  assert.equal(DOMAIN_SUPPORT.ad.like, true);

  assert.equal(DOMAIN_SUPPORT['hub-content'].view, false);
  assert.equal(DOMAIN_SUPPORT['hub-content'].like, true);

  assert.equal(DOMAIN_SUPPORT.profile.like, false);
  assert.equal(DOMAIN_SUPPORT.profile.view, true);
});

test('assertEngagementSupported returns 400 ENGAGEMENT_NOT_SUPPORTED for a known-unsupported combo, never silently passes', () => {
  const bodies: any[] = [];
  const ctx: any = {
    get body() {
      return bodies[bodies.length - 1];
    },
    set body(value: any) {
      bodies.push(value);
    },
    status: 0,
  };

  const ok = assertEngagementSupported(ctx, 'logistics-vehicle', 'like');
  assert.equal(ok, false);
  assert.equal(ctx.status, 400);
  assert.equal(bodies.at(-1).success, false);
  assert.equal(bodies.at(-1).error.code, 'ENGAGEMENT_NOT_SUPPORTED');
});

test('assertEngagementSupported rejects unknown targetType as VALIDATION_ERROR, not ENGAGEMENT_NOT_SUPPORTED', () => {
  const ctx: any = { status: 0, body: undefined };
  const ok = assertEngagementSupported(ctx, 'totally-made-up', 'like');
  assert.equal(ok, false);
  assert.equal(ctx.status, 400);
  assert.equal(ctx.body.error.code, 'VALIDATION_ERROR');
});

test('assertEngagementSupported returns true and touches nothing for a supported combo', () => {
  const ctx: any = { status: 0, body: undefined };
  const ok = assertEngagementSupported(ctx, 'listing', 'like');
  assert.equal(ok, true);
  assert.equal(ctx.status, 0);
  assert.equal(ctx.body, undefined);
});

test('resolveActorKey prefers the JWT identity over a guest id', () => {
  const ctx: any = {
    state: { user: { email: 'Farmer@Example.com' } },
    request: { body: { guestActorId: '11111111-1111-1111-1111-111111111111' } },
  };
  assert.equal(resolveActorKey(ctx), 'user:farmer@example.com');
});

test('resolveActorKey accepts a well-formed guest UUID when unauthenticated', () => {
  const ctx: any = {
    state: {},
    request: { body: { guestActorId: '11111111-1111-1111-1111-111111111111' } },
  };
  assert.equal(resolveActorKey(ctx), 'guest:11111111-1111-1111-1111-111111111111');
});

test('resolveActorKey rejects a malformed guest id (not a UUID) rather than trusting it', () => {
  const ctx: any = {
    state: {},
    request: { body: { guestActorId: 'not-a-uuid-just-anything' } },
  };
  assert.equal(resolveActorKey(ctx), null);
});

test('resolveActorKey returns null with no identity and no body at all', () => {
  const ctx: any = { state: {}, request: {} };
  assert.equal(resolveActorKey(ctx), null);
});

test('buildToggleBody shape matches the contract envelope exactly', () => {
  const body = buildToggleBody({
    active: true,
    changed: true,
    count: 125,
    targetType: 'listing',
    targetId: '123',
    updatedAt: '2026-07-30T20:00:00.000Z',
    serverVersion: 42,
  });
  assert.deepEqual(body, {
    success: true,
    active: true,
    changed: true,
    count: 125,
    target: { type: 'listing', id: '123' },
    updatedAt: '2026-07-30T20:00:00.000Z',
    serverVersion: 42,
    contractVersion: CONTRACT_VERSION,
  });
});

test('buildViewBody shape matches the contract envelope exactly', () => {
  const body = buildViewBody({
    incremented: false,
    count: 901,
    targetType: 'listing',
    targetId: '123',
    updatedAt: '2026-07-30T20:00:00.000Z',
    serverVersion: 42,
  });
  assert.equal(body.incremented, false);
  assert.equal(body.success, true);
  assert.deepEqual(body.target, { type: 'listing', id: '123' });
});

test('buildErrorBody always carries success:false and the contract version', () => {
  const body = buildErrorBody('RATE_LIMITED', 'too many requests');
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'RATE_LIMITED');
  assert.equal(body.contractVersion, CONTRACT_VERSION);
});
