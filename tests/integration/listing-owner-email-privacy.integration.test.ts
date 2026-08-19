/**
 * LISTING_SYSTEM_RELEASE_FORENSIC_AUDIT.md — BUG-LISTING-002 (CRITICAL).
 *
 * `listing.ownerEmail` had no `private:true` flag and listing.ts's
 * controller never overrides find/findOne, so every listing's real
 * seller email was returned verbatim in the public (unauthenticated)
 * `GET /listings` and `GET /listings/:id` responses -- harvestable at
 * scale by any scraper, no auth required. Fixed by marking the schema
 * field `private:true` (Strapi strips it from every REST API response
 * regardless of caller, but leaves it fully readable to backend-internal
 * `entityService`/`db.query` calls, which don't go through the REST
 * output-sanitization step `private` affects).
 *
 * Verified Flutter dependency before this fix: every `ownerEmail` read
 * in the Flutter codebase is a null-safe fallback checked only after
 * `ownerId` (always server-set for every listing) is empty, or feeds a
 * non-critical local cache -- no UI code requires ownerEmail from the
 * listing API response, so no Flutter change was needed.
 *
 * Run: npm run test:integration (real Strapi boot against a throwaway
 * SQLite file — see before() below).
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-listing-owner-email-privacy-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-listing-owner-email-privacy-test.db');
const PORT = 14173;
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

async function registerAndLogin(email: string): Promise<{ jwt: string; ownerId: string; email: string }> {
  const res = await fetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  const json = await res.json();
  const ownerId = `u_${email.trim().toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
  return { jwt: json.jwt, ownerId, email: email.trim().toLowerCase() };
}

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

async function createOwnedListing(owner: { ownerId: string; email: string }) {
  return strapiInstance.entityService.create('api::listing.listing', {
    data: {
      title: 'Gizlilik Test Ilani',
      description: 'Aciklama',
      mainType: 'Tahil',
      price: 100,
      ownerProfileId: owner.ownerId,
      ownerId: owner.ownerId,
      ownerEmail: owner.email,
      ownerName: 'Satici Adi',
      ownerCity: 'Konya',
      status: 'active',
      publishedAt: new Date().toISOString(),
    },
  });
}

test('public GET /listings does not expose ownerEmail, but does expose public owner fields', async () => {
  const seller = await registerAndLogin(`ls-privacy-list-${randomUUID()}@test.local`);
  await createOwnedListing(seller);

  const res = await fetch(`${BASE_URL}/listings?pagination[limit]=100`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const rows: any[] = body.data ?? [];
  assert.ok(rows.length > 0, 'setup: at least one listing must be returned');
  for (const row of rows) {
    const attrs = row.attributes ?? row;
    assert.equal(attrs.ownerEmail, undefined, 'ownerEmail must never appear in the public listings response');
  }
  const sellerRow = rows.find((row) => (row.attributes ?? row).ownerProfileId === seller.ownerId);
  assert.ok(sellerRow, 'setup: the created listing must be findable in the response');
  const sellerAttrs = sellerRow.attributes ?? sellerRow;
  assert.equal(sellerAttrs.ownerName, 'Satici Adi', 'ownerName must remain public');
  assert.equal(sellerAttrs.ownerCity, 'Konya', 'ownerCity must remain public');
  assert.equal(sellerAttrs.ownerProfileId, seller.ownerId, 'ownerProfileId must remain public');
});

test('public GET /listings/:id does not expose ownerEmail', async () => {
  const seller = await registerAndLogin(`ls-privacy-detail-${randomUUID()}@test.local`);
  const listing = await createOwnedListing(seller);

  const res = await fetch(`${BASE_URL}/listings/${listing.documentId}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  const attrs = body.data.attributes ?? body.data;
  assert.equal(attrs.ownerEmail, undefined);
  assert.equal(attrs.ownerProfileId, seller.ownerId);
});

test('an authenticated non-owner also never sees another seller\'s ownerEmail', async () => {
  const seller = await registerAndLogin(`ls-privacy-stranger-seller-${randomUUID()}@test.local`);
  const listing = await createOwnedListing(seller);
  const stranger = await registerAndLogin(`ls-privacy-stranger-${randomUUID()}@test.local`);

  const res = await fetch(`${BASE_URL}/listings/${listing.documentId}`, {
    headers: authed(stranger.jwt),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  const attrs = body.data.attributes ?? body.data;
  assert.equal(attrs.ownerEmail, undefined, 'a logged-in stranger must not see the seller\'s email either');
});

test('backend-internal listing owner resolution (offer receiver) still works with ownerEmail marked private', async () => {
  const seller = await registerAndLogin(`ls-privacy-offer-seller-${randomUUID()}@test.local`);
  const listing = await createOwnedListing(seller);
  const buyer = await registerAndLogin(`ls-privacy-offer-buyer-${randomUUID()}@test.local`);

  const res = await fetch(`${BASE_URL}/offers`, {
    method: 'POST',
    headers: { ...authed(buyer.jwt), 'idempotency-key': `offer_${randomUUID()}` },
    body: JSON.stringify({
      data: {
        offerId: `offer_${randomUUID()}`,
        listingId: String(listing.id),
        title: listing.title,
        priceText: '100 TL',
      },
    }),
  });
  assert.equal(res.status, 201, 'offer creation must still resolve the real listing owner server-side');

  const row = await strapiInstance.db.query('api::offer.offer').findOne({
    where: { requesterEmail: buyer.email },
  } as any);
  assert.equal(
    row.receiverEmail,
    seller.email,
    'private:true must not block backend-internal entityService reads of ownerEmail',
  );
});
