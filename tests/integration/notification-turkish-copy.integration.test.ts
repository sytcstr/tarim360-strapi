/**
 * PRE_UAT_F2_SMALL_FIX_REPORT.md F2.5 (UX-040): the notification title/
 * message constants in notification.ts (DOMAIN_EVENTS), offer.ts
 * (create/accept/reject/bargaining), and message/lifecycles.ts were
 * hardcoded ASCII-only (e.g. "Ilanin Favorilendi", "Karsi Teklif",
 * "Bir kullanici") -- real Turkish diacritics (ğ, ş, ı, İ, ç, ö, ü) never
 * rendered anywhere they were used, across every notification type. This
 * is a source-string fix, not an encoding/charset change; this suite
 * locks in the real, persisted, correctly-accented content coming out of
 * the actual live endpoints (not just the source file), so a future edit
 * reverting any one of these strings back to ASCII fails a real test
 * instead of only being caught by manual UAT reading.
 *
 * Only the `listing` domain is exercised for the DOMAIN_EVENTS map (the
 * logistics_load/processed_product/profile entries share the exact same
 * object and code path -- resolveDomainOwner/the domain-event action
 * itself -- so a structural regression there would already be caught
 * here; standing up logistics-load/processed-product test fixtures just
 * to re-assert sibling string literals was judged not worth the extra
 * Strapi-boot cost for this targeted fix).
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-notification-turkish-copy-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-notification-turkish-copy-test.db');
const PORT = 14179;
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

async function waitForRow<T>(
  fetchRow: () => Promise<T | null | undefined>,
  predicate: (row: T) => boolean,
  { timeoutMs = 2000, intervalMs = 50 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const row = await fetchRow();
    if (row && predicate(row)) return row;
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitForRow timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function createListingAs(jwt: string) {
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({
      data: { title: 'Turkce Kopya Test Ilani', mainType: 'bitkisel', mode: 'sell', location: 'Konya', operationId: randomUUID() },
    }),
  });
  const json = await res.json();
  return json.data;
}

async function domainEvent(jwt: string, body: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/notifications/domain-event`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function createOffer(jwt: string, data: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/offers`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function sendConversationMessage(jwt: string, data: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/conversations/message`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('domain-event: listing favorite stores the correctly-accented title/message ("İlanın Favorilendi" / "...ilanını favorilerine ekledi.")', async () => {
  const owner = await registerAndLogin(`f25-listing-owner-fav-${randomUUID()}@test.local`);
  const fan = await registerAndLogin(`f25-listing-fan-fav-${randomUUID()}@test.local`);
  const listing = await createListingAs(owner.jwt);

  const { status } = await domainEvent(fan.jwt, {
    domain: 'listing',
    entityId: String(listing.documentId ?? listing.id),
    event: 'favorite',
  });
  assert.equal(status, 200);

  const row = await waitForRow(
    () =>
      strapiInstance.db.query('api::notification.notification').findOne({
        where: { targetEmail: owner.email, event: 'favorite', source: 'listing' },
      } as any),
    (r: any) => Boolean(r),
  );
  assert.equal(row.title, 'İlanın Favorilendi');
  assert.ok(row.message.endsWith('ilanını favorilerine ekledi.'), `unexpected message: ${row.message}`);
  assert.ok(!/[Ii]lanin /.test(row.title), 'title must not regress to the ASCII-only "Ilanin" spelling');
});

test('domain-event: listing like stores "İlanın Beğenildi" / "...ilanını beğendi."', async () => {
  const owner = await registerAndLogin(`f25-listing-owner-like-${randomUUID()}@test.local`);
  const fan = await registerAndLogin(`f25-listing-fan-like-${randomUUID()}@test.local`);
  const listing = await createListingAs(owner.jwt);

  const { status } = await domainEvent(fan.jwt, {
    domain: 'listing',
    entityId: String(listing.documentId ?? listing.id),
    event: 'like',
  });
  assert.equal(status, 200);

  const row = await waitForRow(
    () =>
      strapiInstance.db.query('api::notification.notification').findOne({
        where: { targetEmail: owner.email, event: 'like', source: 'listing' },
      } as any),
    (r: any) => Boolean(r),
  );
  assert.equal(row.title, 'İlanın Beğenildi');
  assert.ok(row.message.endsWith('ilanını beğendi.'), `unexpected message: ${row.message}`);
});

test('offer created: the receiver notification uses "için yeni teklif aldınız." (not the ASCII "icin ... aldiniz.")', async () => {
  const owner = await registerAndLogin(`f25-offer-owner-created-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`f25-offer-buyer-created-${randomUUID()}@test.local`);
  const listing = await createListingAs(owner.jwt);
  const offerId = `offer_${randomUUID()}`;

  const { status } = await createOffer(buyer.jwt, {
    offerId, listingId: String(listing.documentId ?? listing.id), title: listing.title,
  });
  assert.equal(status, 201);

  const row = await waitForRow(
    () =>
      strapiInstance.db.query('api::notification.notification').findOne({
        where: { targetEmail: owner.email, event: 'created', source: 'offer' },
      } as any),
    (r: any) => Boolean(r),
  );
  assert.equal(row.title, 'Yeni Teklif');
  assert.ok(row.message.includes('için yeni teklif aldınız.'), `unexpected message: ${row.message}`);
});

test('offer countered (bargaining): the notified participant sees "Karşı Teklif" (not the ASCII "Karsi Teklif")', async () => {
  const owner = await registerAndLogin(`f25-offer-owner-bargain-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`f25-offer-buyer-bargain-${randomUUID()}@test.local`);
  const listing = await createListingAs(owner.jwt);
  const offerId = `offer_${randomUUID()}`;
  await createOffer(buyer.jwt, { offerId, listingId: String(listing.documentId ?? listing.id), title: listing.title });

  const res = await fetch(`${BASE_URL}/offers/${offerId}/by-offer-id`, {
    method: 'PATCH',
    headers: authed(owner.jwt),
    body: JSON.stringify({ data: { offerStatus: 'bargaining' } }),
  });
  assert.equal(res.status, 200);

  const row = await waitForRow(
    () =>
      strapiInstance.db.query('api::notification.notification').findOne({
        where: { targetEmail: buyer.email, event: 'bargaining', source: 'offer' },
      } as any),
    (r: any) => Boolean(r),
  );
  assert.equal(row.title, 'Karşı Teklif');
  assert.ok(row.message.endsWith('teklifi güncellendi.'), `unexpected message: ${row.message}`);
});

test('a real chat message notification title carries the listing\'s canonical T360 number, and the body carries the message text with its diacritics intact', async () => {
  const owner = await registerAndLogin(`f25-msg-owner-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`f25-msg-buyer-${randomUUID()}@test.local`);
  const listing = await createListingAs(owner.jwt);

  const { status } = await sendConversationMessage(buyer.jwt, {
    message: 'İlanınızla ilgileniyorum, müsait misiniz?',
    listingId: String(listing.documentId ?? listing.id),
  });
  assert.equal(status, 200);

  const row = await waitForRow(
    () =>
      strapiInstance.db.query('api::notification.notification').findOne({
        where: { targetEmail: owner.email, kind: 'message' },
      } as any),
    (r: any) => Boolean(r),
  );
  // LISTING_L8_MESSAGING_LISTING_CONTEXT_REPORT.md L8.9: the title now
  // carries the message's own canonical listingNo snapshot (server-
  // derived from the real listing, see message/lifecycles.ts) whenever
  // the conversation resolves to a real listing -- this test's listing
  // does, so the plain 'Yeni Mesaj' title only applies to a message
  // with no resolvable listing context (covered separately in
  // tarim360-strapi's conversation-listing-context.integration.test.ts).
  assert.equal(row.title, `Yeni Mesaj — T360-${listing.listingNo}`);
  assert.ok(
    row.message.includes('İlanınızla ilgileniyorum, müsait misiniz?'),
    `unexpected message: ${row.message}`,
  );
});
