/**
 * LISTING_L9_OWNER_BUYER_ACTION_POLICY_REPORT.md.
 *
 * Covers what L9 actually changed on the backend:
 *  - a listing's OWNER viewing their own listing must not inflate its own
 *    viewCount, via both the canonical POST /engagements/view route
 *    (engagement-v1.ts) and the legacy POST /listing-views route
 *    (listing-view.ts) -- neither had this exclusion before this phase,
 *    unlike likes/favorites (isOwnListingTarget), which already did.
 *  - a real, non-owner visitor's view still increments normally through
 *    both routes (regression, not just the self-view branch).
 *  - offer creation is now rejected for a real listing that resolves but
 *    is not `active` (mirrors conversation.ts's pre-existing
 *    listing_not_active guard for new message threads) -- a non-
 *    resolving listingId still falls through unchanged, matching that
 *    same established precedent.
 *  - `status` is now a server-protected field on listing update: a
 *    client PUT can no longer flip it, closing the one lifecycle field
 *    that wasn't already protected alongside every counter/premium/
 *    rocket/listingNo/search field.
 *  - self-offer and self-like/self-favorite protections (pre-existing,
 *    unmodified by this phase) are re-confirmed here as part of L9.6/
 *    L9.8's required regression coverage.
 *
 * Run: npm run test:integration (real Strapi boot against a throwaway
 * SQLite file -- see before() below).
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-listing-owner-buyer-action-policy-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-listing-owner-buyer-action-policy-test.db');
const PORT = 14186;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

let strapiInstance: any;

before(async () => {
  if (existsSync(TEST_DB_FILE)) unlinkSync(TEST_DB_FILE);
  process.env.DATABASE_CLIENT = 'sqlite';
  process.env.DATABASE_FILENAME = TEST_DB_FILE_RELATIVE;
  process.env.PORT = String(PORT);
  const compiled = await compileStrapi();
  strapiInstance = await createStrapi(compiled).load();
  await strapiInstance.server.listen(PORT);
});

after(async () => {
  await strapiInstance?.server?.close?.();
  await strapiInstance?.destroy?.();
  if (existsSync(TEST_DB_FILE)) unlinkSync(TEST_DB_FILE);
});

async function registerAndLogin(email: string): Promise<{ jwt: string }> {
  const res = await fetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  const json = await res.json();
  return { jwt: json.jwt };
}

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

async function createListing(jwt: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({
      data: {
        title: 'L9 Test Ilani',
        mainType: 'tarim',
        mode: 'sell',
        price: 100,
        location: { city: 'Konya' },
        operationId: randomUUID(),
        ...overrides,
      },
    }),
  });
  const json = await res.json();
  if (res.status >= 400) {
    throw new Error(`createListing failed (${res.status}): ${JSON.stringify(json)}`);
  }
  return json.data;
}

async function postView(jwt: string | null, targetId: string) {
  const res = await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: jwt ? authed(jwt) : { 'content-type': 'application/json' },
    body: JSON.stringify({
      targetType: 'listing',
      targetId,
      ...(jwt ? {} : { guestActorId: `guest_${randomUUID()}` }),
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function postLegacyListingView(jwt: string, listingId: string) {
  const res = await fetch(`${BASE_URL}/listing-views`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data: { listingId } }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function fetchListingViewCount(documentId: string): Promise<number> {
  const row = await strapiInstance.db
    .query('api::listing.listing')
    .findOne({ where: { documentId, publishedAt: { $ne: null } } } as any);
  return Number(row?.viewCount ?? 0);
}

// ---------------------------------------------------------------------
// L9.9 -- listing self-view exclusion (new in this phase)
// ---------------------------------------------------------------------

test('L9.9: an owner viewing their own listing via POST /engagements/view does not inflate its viewCount', async () => {
  const owner = await registerAndLogin(`l9-selfview-owner-${randomUUID()}@test.local`);
  const listing = await createListing(owner.jwt, { title: `Self View Test ${randomUUID()}` });
  assert.equal(await fetchListingViewCount(listing.documentId), 0);

  const { status, body } = await postView(owner.jwt, listing.documentId);
  assert.equal(status, 200);
  assert.equal(body.data?.count ?? body.count, 0, 'the owner must not inflate their own listing view count');
  assert.equal(await fetchListingViewCount(listing.documentId), 0);
});

test('L9.9 regression: a real visitor viewing a listing via POST /engagements/view still increments it normally', async () => {
  const owner = await registerAndLogin(`l9-realview-owner-${randomUUID()}@test.local`);
  const visitor = await registerAndLogin(`l9-realview-visitor-${randomUUID()}@test.local`);
  const listing = await createListing(owner.jwt, { title: `Real View Test ${randomUUID()}` });

  const { status, body } = await postView(visitor.jwt, listing.documentId);
  assert.equal(status, 200);
  assert.equal(body.data?.count ?? body.count, 1, 'a real visitor view must still increment the listing viewCount');
  assert.equal(await fetchListingViewCount(listing.documentId), 1);
});

test('L9.9: an owner viewing their own listing via the legacy POST /listing-views route also does not inflate its viewCount', async () => {
  const owner = await registerAndLogin(`l9-selfview-legacy-owner-${randomUUID()}@test.local`);
  const listing = await createListing(owner.jwt, { title: `Self View Legacy Test ${randomUUID()}` });

  const { status } = await postLegacyListingView(owner.jwt, listing.documentId);
  assert.equal(status, 200);
  assert.equal(await fetchListingViewCount(listing.documentId), 0);
});

test('L9.9 regression: a real visitor using the legacy POST /listing-views route still increments the viewCount', async () => {
  const owner = await registerAndLogin(`l9-realview-legacy-owner-${randomUUID()}@test.local`);
  const visitor = await registerAndLogin(`l9-realview-legacy-visitor-${randomUUID()}@test.local`);
  const listing = await createListing(owner.jwt, { title: `Real View Legacy Test ${randomUUID()}` });

  const { status } = await postLegacyListingView(visitor.jwt, listing.documentId);
  assert.equal(status, 200);
  assert.equal(await fetchListingViewCount(listing.documentId), 1);
});

// ---------------------------------------------------------------------
// L9.10 -- offer creation on an inactive listing (new in this phase)
// ---------------------------------------------------------------------

test('L9.10: creating an offer on a listing that resolves but is not active is rejected', async () => {
  const owner = await registerAndLogin(`l9-offer-inactive-owner-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`l9-offer-inactive-buyer-${randomUUID()}@test.local`);
  const listing = await createListing(owner.jwt, { title: `Inactive Offer Test ${randomUUID()}` });
  await strapiInstance.db.query('api::listing.listing').updateMany({
    where: { documentId: listing.documentId },
    data: { status: 'rejected' },
  });

  const offerId = `offer_${randomUUID()}`;
  const res = await fetch(`${BASE_URL}/offers`, {
    method: 'POST',
    headers: authed(buyer.jwt),
    body: JSON.stringify({
      data: { offerId, listingId: listing.documentId, title: listing.title },
    }),
  });
  assert.equal(res.status, 403);
});

test('L9.10 regression: creating an offer on a listing with a non-resolving/legacy context id still falls through unchanged', async () => {
  const buyer = await registerAndLogin(`l9-offer-legacy-buyer-${randomUUID()}@test.local`);
  const offerId = `offer_${randomUUID()}`;
  // Digit-free on purpose, including the literal prefix itself (not just
  // the randomUUID() portion) -- idCandidates() extracts ANY numeric
  // substring from the raw id and treats it as a candidate row id, so a
  // prefix like "l9" (containing a literal "9") can coincidentally
  // collide with a real listing's numeric id in a shared test-run
  // database, exactly the class of risk already disclosed for this same
  // helper in LISTING_L8_MESSAGING_LISTING_CONTEXT_REPORT.md.
  const fakeListingId = `listing-synthetic-lnine-${randomUUID().replace(/[0-9]/g, 'x')}`;

  const res = await fetch(`${BASE_URL}/offers`, {
    method: 'POST',
    headers: authed(buyer.jwt),
    body: JSON.stringify({
      data: {
        offerId,
        listingId: fakeListingId,
        title: 'Legacy Context Offer',
        receiverEmail: `l9-offer-legacy-seller-${randomUUID()}@test.local`,
      },
    }),
  });
  assert.equal(res.status, 201, 'a non-resolving listingId must not be treated as inactive');
});

test('L9.10 regression: an offer on a real, active listing is still created normally', async () => {
  const owner = await registerAndLogin(`l9-offer-active-owner-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`l9-offer-active-buyer-${randomUUID()}@test.local`);
  const listing = await createListing(owner.jwt, { title: `Active Offer Test ${randomUUID()}` });

  const offerId = `offer_${randomUUID()}`;
  const res = await fetch(`${BASE_URL}/offers`, {
    method: 'POST',
    headers: authed(buyer.jwt),
    body: JSON.stringify({ data: { offerId, listingId: listing.documentId, title: listing.title } }),
  });
  assert.equal(res.status, 201);
});

// ---------------------------------------------------------------------
// L9.6/L9.7/L9.8 -- pre-existing self-action protections, re-confirmed
// (unmodified by this phase, required by L9's own test matrix)
// ---------------------------------------------------------------------

test('L9.6 regression: an owner cannot create an offer on their own listing', async () => {
  const owner = await registerAndLogin(`l9-selfoffer-owner-${randomUUID()}@test.local`);
  const listing = await createListing(owner.jwt, { title: `Self Offer Test ${randomUUID()}` });

  const offerId = `offer_${randomUUID()}`;
  const res = await fetch(`${BASE_URL}/offers`, {
    method: 'POST',
    headers: authed(owner.jwt),
    body: JSON.stringify({ data: { offerId, listingId: listing.documentId, title: listing.title } }),
  });
  assert.equal(res.status, 403);
});

test('L9.8 regression: an owner cannot like or favorite their own listing', async () => {
  const owner = await registerAndLogin(`l9-selflike-owner-${randomUUID()}@test.local`);
  const listing = await createListing(owner.jwt, { title: `Self Like Test ${randomUUID()}` });

  const likeRes = await fetch(`${BASE_URL}/engagements/like`, {
    method: 'PUT',
    headers: authed(owner.jwt),
    body: JSON.stringify({ targetType: 'listing', targetId: listing.documentId }),
  });
  assert.equal(likeRes.status, 403);

  const favRes = await fetch(`${BASE_URL}/engagements/favorite`, {
    method: 'PUT',
    headers: authed(owner.jwt),
    body: JSON.stringify({ targetType: 'listing', targetId: listing.documentId }),
  });
  assert.equal(favRes.status, 403);
});

// ---------------------------------------------------------------------
// L9.10 -- `status` client-protected field (new in this phase)
// ---------------------------------------------------------------------

test('L9.10: a client PUT can no longer flip a listing\'s own status', async () => {
  const owner = await registerAndLogin(`l9-status-spoof-owner-${randomUUID()}@test.local`);
  const listing = await createListing(owner.jwt, { title: `Status Spoof Test ${randomUUID()}` });
  assert.equal(listing.status ?? 'active', 'active');

  const res = await fetch(`${BASE_URL}/listings/${listing.documentId}`, {
    method: 'PUT',
    headers: authed(owner.jwt),
    body: JSON.stringify({ data: { status: 'rejected' } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.notEqual(body.data.status, 'rejected', 'status must not be settable by a client PUT');
  assert.equal(body.data.status ?? 'active', 'active');
});
