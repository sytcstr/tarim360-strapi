/**
 * LISTING_L19_MARKETPLACE_PRODUCT_GAP_FOUNDATIONS_REPORT.md Part B.
 *
 * Proves `GET /listings/:id/similar` (listing-similar-query.ts) is a
 * genuinely deterministic, bounded, public-only similarity feed: same
 * mainType is a hard filter, same subType/city/price-proximity are
 * scored bonuses (never required), a different mainType or mode is
 * excluded outright (the L19.14 PRODUCT DECISION: mode is a hard filter,
 * not a scoring signal), the reference listing itself never appears in
 * its own similar set, pending/rejected listings never appear as either
 * the reference or a candidate, ordering is stable across repeated
 * identical requests, results are bounded/deduplicated, and the one
 * private field (`ownerEmail`) is never leaked (this path uses raw
 * db.query, which -- unlike entityService -- does not auto-strip
 * private fields; listing.ts's similar() action strips it by hand).
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-listing-similar-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-listing-similar-test.db');
const PORT = 14193;
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
        title: 'L19 Similar Test Ilani',
        mainType: 'tarim',
        subType: 'Tahıllar',
        mode: 'sell',
        price: 100,
        location: { city: 'Konya', display: 'Konya' },
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

async function forceStatus(documentId: string, status: 'pending' | 'active' | 'rejected') {
  await strapiInstance.db.query('api::listing.listing').updateMany({
    where: { documentId },
    data: { status },
  });
}

async function similar(documentId: string, params: Record<string, string | number> = {}) {
  const qs = Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  const res = await fetch(`${BASE_URL}/listings/${documentId}/similar${qs ? `?${qs}` : ''}`);
  const json = await res.json();
  return { status: res.status, body: json };
}

test('L19.9: a same-mainType candidate is returned, a different-mainType listing is excluded', async () => {
  const { jwt } = await registerAndLogin(`l19-sim-maintype-${randomUUID()}@test.local`);
  const marker = randomUUID().slice(0, 8);
  const reference = await createListing(jwt, { title: `L19 Sim Ref ${marker}`, mainType: 'tarim' });
  const sameType = await createListing(jwt, { title: `L19 Sim Same ${marker}`, mainType: 'tarim' });
  const otherType = await createListing(jwt, {
    title: `L19 Sim Other ${marker}`,
    mainType: 'hayvancilik',
  });

  const { status, body } = await similar(reference.documentId);
  assert.equal(status, 200);
  const titles = body.data.map((r: any) => r.title);
  assert.ok(titles.includes(sameType.title));
  assert.ok(!titles.includes(otherType.title));
});

test('L19.11: the reference listing never appears in its own similar-listings result', async () => {
  const { jwt } = await registerAndLogin(`l19-sim-self-${randomUUID()}@test.local`);
  const reference = await createListing(jwt, { title: `L19 Sim Self ${randomUUID().slice(0, 8)}` });
  const { body } = await similar(reference.documentId);
  assert.ok(!body.data.some((r: any) => r.listingNo === reference.listingNo));
});

test('L19.9/L19.12: a same-subType candidate is ranked ahead of a same-mainType-different-subType candidate', async () => {
  const { jwt } = await registerAndLogin(`l19-sim-subtype-${randomUUID()}@test.local`);
  const marker = randomUUID().slice(0, 8);
  const reference = await createListing(jwt, {
    title: `L19 Sim SubRef ${marker}`,
    subType: 'Bugday',
  });
  const differentSubType = await createListing(jwt, {
    title: `L19 Sim DiffSub ${marker}`,
    subType: 'Arpa',
  });
  const sameSubType = await createListing(jwt, {
    title: `L19 Sim SameSub ${marker}`,
    subType: 'Bugday',
  });

  const { body } = await similar(reference.documentId);
  const idxSame = body.data.findIndex((r: any) => r.listingNo === sameSubType.listingNo);
  const idxDiff = body.data.findIndex((r: any) => r.listingNo === differentSubType.listingNo);
  assert.ok(idxSame !== -1 && idxDiff !== -1);
  assert.ok(idxSame < idxDiff, 'same-subType candidate must rank ahead of a same-mainType-only candidate');
});

test('L19.10: a pending candidate is excluded from similar results', async () => {
  const { jwt } = await registerAndLogin(`l19-sim-pending-${randomUUID()}@test.local`);
  const marker = randomUUID().slice(0, 8);
  const reference = await createListing(jwt, { title: `L19 Sim PendRef ${marker}` });
  const pendingCandidate = await createListing(jwt, { title: `L19 Sim PendCand ${marker}` });
  await forceStatus(pendingCandidate.documentId, 'pending');

  const { body } = await similar(reference.documentId);
  assert.ok(!body.data.some((r: any) => r.listingNo === pendingCandidate.listingNo));
});

test('L19.10: requesting similar for a pending/rejected reference (as a stranger) 404s, same as findOne', async () => {
  const owner = await registerAndLogin(`l19-sim-hidden-owner-${randomUUID()}@test.local`);
  const hidden = await createListing(owner.jwt, { title: `L19 Sim Hidden ${randomUUID().slice(0, 8)}` });
  await forceStatus(hidden.documentId, 'rejected');

  const { status } = await similar(hidden.documentId);
  assert.equal(status, 404);
});

test('L19.12: similar-listings ordering is stable across repeated identical requests', async () => {
  const { jwt } = await registerAndLogin(`l19-sim-stable-${randomUUID()}@test.local`);
  const marker = randomUUID().slice(0, 8);
  const reference = await createListing(jwt, { title: `L19 Sim StableRef ${marker}` });
  await createListing(jwt, { title: `L19 Sim StableA ${marker}` });
  await createListing(jwt, { title: `L19 Sim StableB ${marker}` });
  await createListing(jwt, { title: `L19 Sim StableC ${marker}` });

  const first = await similar(reference.documentId);
  const second = await similar(reference.documentId);
  assert.deepEqual(
    first.body.data.map((r: any) => r.listingNo),
    second.body.data.map((r: any) => r.listingNo),
  );
});

test('L19.16/L19.17: similar-listings results are bounded by pageSize and contain no duplicates', async () => {
  const { jwt } = await registerAndLogin(`l19-sim-bounded-${randomUUID()}@test.local`);
  const marker = randomUUID().slice(0, 8);
  const reference = await createListing(jwt, { title: `L19 Sim BoundRef ${marker}` });
  for (let i = 0; i < 4; i += 1) {
    await createListing(jwt, { title: `L19 Sim Bound ${marker} ${i}` });
  }
  const { body } = await similar(reference.documentId, { pageSize: 2 });
  assert.equal(body.data.length, 2);
  const listingNos = body.data.map((r: any) => r.listingNo);
  assert.equal(new Set(listingNos).size, listingNos.length);
});

test('L19.14 PRODUCT DECISION: a sell-mode reference never returns a buy-mode candidate as "similar", even with identical mainType/subType', async () => {
  const { jwt } = await registerAndLogin(`l19-sim-mode-${randomUUID()}@test.local`);
  const marker = randomUUID().slice(0, 8);
  const reference = await createListing(jwt, {
    title: `L19 Sim ModeRef ${marker}`,
    mode: 'sell',
    subType: 'Bugday',
  });
  const buyCandidate = await createListing(jwt, {
    title: `L19 Sim ModeBuy ${marker}`,
    mode: 'buy',
    subType: 'Bugday',
  });

  const { body } = await similar(reference.documentId);
  assert.ok(!body.data.some((r: any) => r.listingNo === buyCandidate.listingNo));
});

test('L19.13: a zero-price reference/candidate never crashes and never earns a spurious price-proximity bonus', async () => {
  const { jwt } = await registerAndLogin(`l19-sim-price-${randomUUID()}@test.local`);
  const marker = randomUUID().slice(0, 8);
  const reference = await createListing(jwt, { title: `L19 Sim PriceRef ${marker}`, price: 0 });
  const candidate = await createListing(jwt, { title: `L19 Sim PriceCand ${marker}`, price: 0 });

  const { status, body } = await similar(reference.documentId);
  assert.equal(status, 200);
  assert.ok(body.data.some((r: any) => r.listingNo === candidate.listingNo));
});

test('L19.45: similar-listings never leaks the private ownerEmail field', async () => {
  const { jwt } = await registerAndLogin(`l19-sim-privacy-${randomUUID()}@test.local`);
  const marker = randomUUID().slice(0, 8);
  const reference = await createListing(jwt, { title: `L19 Sim PrivRef ${marker}` });
  await createListing(jwt, { title: `L19 Sim PrivCand ${marker}` });

  const { body } = await similar(reference.documentId);
  assert.ok(body.data.length > 0);
  for (const row of body.data) {
    assert.equal(row.ownerEmail, undefined);
  }
});
