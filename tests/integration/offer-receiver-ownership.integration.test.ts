/**
 * SPRINT 4 / O1 (OFFER_SYSTEM_FORENSIC_AUDIT.md, BUG-OFFER-001,
 * OFFER_O1_CORE_FIX_REPORT.md) -- an offer's receiver was only resolved
 * against the listing's real owner when the client omitted BOTH
 * receiverEmail and receiverProfileId. The real Flutter client always
 * sends both, so the server had zero independent verification that an
 * offer's receiver was actually the listing's owner -- confirmed live
 * during the audit: an attacker could create a 201 offer targeting an
 * arbitrary victim on a listing that didn't even need to exist. The
 * requester side was already safe (always server-derived from the JWT);
 * this suite proves the receiver side is too, now, and that markSeen
 * (previously unreachable -- same missing-permission bug class as
 * markRead before it) works for a real participant.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-offer-receiver-ownership-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-offer-receiver-ownership-test.db');
const PORT = 14165;
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

async function registerAndLogin(email: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  const json = await res.json();
  return json.jwt;
}

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

async function createListingAs(jwt: string) {
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({
      data: { title: 'O1 Test Ilani', mainType: 'bitkisel', mode: 'sell', location: 'Konya' },
    }),
  });
  const json = await res.json();
  return json.data;
}

async function createOffer(jwt: string, data: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/offers`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const findOfferRow = async (offerId: string) =>
  strapiInstance.db.query('api::offer.offer').findOne({ where: { offerId } } as any);

test('a normal offer (no receiver fields supplied) still resolves to the real listing owner', async () => {
  const ownerEmail = `o1-owner-a-${randomUUID()}@test.local`;
  const buyerEmail = `o1-buyer-a-${randomUUID()}@test.local`;
  const ownerJwt = await registerAndLogin(ownerEmail);
  const buyerJwt = await registerAndLogin(buyerEmail);
  const listing = await createListingAs(ownerJwt);

  const offerId = `offer_${randomUUID()}`;
  const { status } = await createOffer(buyerJwt, {
    offerId,
    listingId: String(listing.documentId ?? listing.id),
    title: listing.title,
  });
  assert.equal(status, 201);

  const row = await findOfferRow(offerId);
  assert.equal(row.requesterEmail, buyerEmail.toLowerCase());
  assert.equal(row.receiverEmail, ownerEmail.toLowerCase());
});

test('BUG-OFFER-001: an attacker-supplied receiver is overridden by the real listing owner, not trusted', async () => {
  const ownerEmail = `o1-owner-b-${randomUUID()}@test.local`;
  const attackerEmail = `o1-attacker-b-${randomUUID()}@test.local`;
  const victimEmail = `o1-victim-b-${randomUUID()}@test.local`;
  const ownerJwt = await registerAndLogin(ownerEmail);
  const attackerJwt = await registerAndLogin(attackerEmail);
  await registerAndLogin(victimEmail);
  const listing = await createListingAs(ownerJwt);

  const offerId = `offer_${randomUUID()}`;
  const { status } = await createOffer(attackerJwt, {
    offerId,
    listingId: String(listing.documentId ?? listing.id),
    title: 'Fake teklif',
    // attacker supplies BOTH fields, pointing at an unrelated victim --
    // this is exactly the payload shape the real Flutter client always
    // sends, and exactly what the audit reproduced live pre-fix.
    receiverEmail: victimEmail,
    receiverProfileId: `u_${victimEmail.replace(/[^a-z0-9]/g, '_')}`,
  });
  assert.equal(status, 201);

  const row = await findOfferRow(offerId);
  assert.equal(row.requesterEmail, attackerEmail.toLowerCase(), 'requester must still be the real caller');
  assert.equal(
    row.receiverEmail,
    ownerEmail.toLowerCase(),
    'receiver must be the REAL listing owner, not the attacker-supplied victim',
  );
  assert.notEqual(row.receiverEmail, victimEmail.toLowerCase());
});

test('an unresolvable listingId falls back to the client-supplied receiver (no regression for edge cases)', async () => {
  const requesterEmail = `o1-fallback-req-${randomUUID()}@test.local`;
  const receiverEmail = `o1-fallback-recv-${randomUUID()}@test.local`;
  const reqJwt = await registerAndLogin(requesterEmail);
  await registerAndLogin(receiverEmail);

  const offerId = `offer_${randomUUID()}`;
  const { status } = await createOffer(reqJwt, {
    offerId,
    listingId: 'no-such-listing-ever',
    title: 'Fallback test',
    receiverEmail,
    receiverProfileId: `u_${receiverEmail.replace(/[^a-z0-9]/g, '_')}`,
  });
  assert.equal(status, 201);

  const row = await findOfferRow(offerId);
  assert.equal(row.receiverEmail, receiverEmail.toLowerCase());
});

test('self-offer is still blocked when the resolved listing owner is the requester', async () => {
  const email = `o1-self-${randomUUID()}@test.local`;
  const jwt = await registerAndLogin(email);
  const listing = await createListingAs(jwt);

  const { status, body } = await createOffer(jwt, {
    offerId: `offer_${randomUUID()}`,
    listingId: String(listing.documentId ?? listing.id),
    title: listing.title,
  });
  // Rejected by the offer-ownership POLICY (runs before the controller,
  // on the stock POST /offers route) -- 403, not the controller's own
  // 400 equivalent, since the policy denies the request before the
  // controller ever runs. Previously this crashed with a raw 500
  // (ctx.forbidden is not a function in a policy context -- fixed
  // alongside O1, see OFFER_O1_CORE_FIX_REPORT.md). Strapi's own policy
  // pipeline replaces whatever message a policy sets with a generic
  // "Policy Failed" once it returns false -- a pre-existing platform
  // characteristic, not something O1 changes -- so the assertion here
  // is on the (now-clean, non-crashing) status code, not message text.
  assert.equal(status, 403);
  assert.equal(body.error?.name, 'PolicyError');
});

test('markSeen is now reachable for a real participant', async () => {
  const ownerEmail = `o1-seen-owner-${randomUUID()}@test.local`;
  const buyerEmail = `o1-seen-buyer-${randomUUID()}@test.local`;
  const ownerJwt = await registerAndLogin(ownerEmail);
  const buyerJwt = await registerAndLogin(buyerEmail);
  const listing = await createListingAs(ownerJwt);

  const offerId = `offer_${randomUUID()}`;
  await createOffer(buyerJwt, {
    offerId,
    listingId: String(listing.documentId ?? listing.id),
    title: listing.title,
  });

  const res = await fetch(`${BASE_URL}/offers/${offerId}/seen`, {
    method: 'PATCH',
    headers: authed(ownerJwt),
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200, 'a real participant must be able to mark the offer seen');

  const row = await findOfferRow(offerId);
  assert.ok(row.seenAt, 'seenAt must be persisted');
});

test('markSeen is still forbidden for a non-participant', async () => {
  const ownerEmail = `o1-seen-np-owner-${randomUUID()}@test.local`;
  const buyerEmail = `o1-seen-np-buyer-${randomUUID()}@test.local`;
  const strangerEmail = `o1-seen-np-stranger-${randomUUID()}@test.local`;
  const ownerJwt = await registerAndLogin(ownerEmail);
  const buyerJwt = await registerAndLogin(buyerEmail);
  const strangerJwt = await registerAndLogin(strangerEmail);
  const listing = await createListingAs(ownerJwt);

  const offerId = `offer_${randomUUID()}`;
  await createOffer(buyerJwt, {
    offerId,
    listingId: String(listing.documentId ?? listing.id),
    title: listing.title,
  });

  const res = await fetch(`${BASE_URL}/offers/${offerId}/seen`, {
    method: 'PATCH',
    headers: authed(strangerJwt),
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------
// offerCount (listing-metrics.ts's recountListingOffers)
// ---------------------------------------------------------------------

const getListingOfferCount = async (listingDocumentId: string) => {
  const row = await strapiInstance.db.query('api::listing.listing').findOne({
    where: { documentId: listingDocumentId },
  } as any);
  return row?.offerCount ?? 0;
};

test('offerCount: creating an offer increments the listing counter', async () => {
  const ownerEmail = `o1-count-owner-a-${randomUUID()}@test.local`;
  const buyerEmail = `o1-count-buyer-a-${randomUUID()}@test.local`;
  const ownerJwt = await registerAndLogin(ownerEmail);
  const buyerJwt = await registerAndLogin(buyerEmail);
  const listing = await createListingAs(ownerJwt);
  const listingId = String(listing.documentId ?? listing.id);

  assert.equal(await getListingOfferCount(listing.documentId), 0);

  await createOffer(buyerJwt, { offerId: `offer_${randomUUID()}`, listingId, title: listing.title });
  assert.equal(await getListingOfferCount(listing.documentId), 1);

  const buyer2Jwt = await registerAndLogin(`o1-count-buyer-a2-${randomUUID()}@test.local`);
  await createOffer(buyer2Jwt, { offerId: `offer_${randomUUID()}`, listingId, title: listing.title });
  assert.equal(await getListingOfferCount(listing.documentId), 2);
});

test('offerCount: accept/reject/bargain status changes do NOT change the count (no row added/removed)', async () => {
  const ownerEmail = `o1-count-owner-b-${randomUUID()}@test.local`;
  const buyerEmail = `o1-count-buyer-b-${randomUUID()}@test.local`;
  const ownerJwt = await registerAndLogin(ownerEmail);
  const buyerJwt = await registerAndLogin(buyerEmail);
  const listing = await createListingAs(ownerJwt);
  const listingId = String(listing.documentId ?? listing.id);

  const offerId = `offer_${randomUUID()}`;
  await createOffer(buyerJwt, { offerId, listingId, title: listing.title });
  assert.equal(await getListingOfferCount(listing.documentId), 1);

  const res = await fetch(`${BASE_URL}/offers/${offerId}/by-offer-id`, {
    method: 'PATCH',
    headers: authed(ownerJwt),
    body: JSON.stringify({ data: { offerStatus: 'accepted' } }),
  });
  assert.equal(res.status, 200);
  assert.equal(await getListingOfferCount(listing.documentId), 1, 'accepting must not change the offer count');
});

test('offerCount: deleting an offer decrements the listing counter', async () => {
  const ownerEmail = `o1-count-owner-c-${randomUUID()}@test.local`;
  const buyerEmail = `o1-count-buyer-c-${randomUUID()}@test.local`;
  const ownerJwt = await registerAndLogin(ownerEmail);
  const buyerJwt = await registerAndLogin(buyerEmail);
  const listing = await createListingAs(ownerJwt);
  const listingId = String(listing.documentId ?? listing.id);

  const offerId = `offer_${randomUUID()}`;
  await createOffer(buyerJwt, { offerId, listingId, title: listing.title });
  assert.equal(await getListingOfferCount(listing.documentId), 1);

  const res = await fetch(`${BASE_URL}/offers/${offerId}/by-offer-id`, {
    method: 'DELETE',
    headers: authed(buyerJwt),
  });
  assert.equal(res.status, 200);
  assert.equal(await getListingOfferCount(listing.documentId), 0);
});

test('offerCount never goes negative and stays accurate across a mixed create/delete sequence', async () => {
  const ownerEmail = `o1-count-owner-d-${randomUUID()}@test.local`;
  const ownerJwt = await registerAndLogin(ownerEmail);
  const listing = await createListingAs(ownerJwt);
  const listingId = String(listing.documentId ?? listing.id);

  const buyers = await Promise.all(
    [1, 2, 3].map((n) => registerAndLogin(`o1-count-buyer-d${n}-${randomUUID()}@test.local`)),
  );
  const offerIds = [`offer_${randomUUID()}`, `offer_${randomUUID()}`, `offer_${randomUUID()}`];
  for (let i = 0; i < 3; i++) {
    await createOffer(buyers[i], { offerId: offerIds[i], listingId, title: listing.title });
  }
  assert.equal(await getListingOfferCount(listing.documentId), 3);

  await fetch(`${BASE_URL}/offers/${offerIds[1]}/by-offer-id`, {
    method: 'DELETE',
    headers: authed(buyers[1]),
  });
  assert.equal(await getListingOfferCount(listing.documentId), 2);
});
