/**
 * NOTIFICATION_N1_SECURITY_FIX_REPORT.md — Sprint 8 targeted security fix.
 *
 * Covers:
 *  N1.1 BUG-NOTIF-001 (CRITICAL): POST /api/notifications used to accept
 *       a client-supplied targetEmail/targetProfileId as-is -- arbitrary
 *       notification (and real push) injection to any victim. Now
 *       self-target-only; cross-user "social interaction" notifications
 *       go through the new, per-domain-verified
 *       POST /notifications/domain-event action instead.
 *  N1.2 BUG-NOTIF-002 (HIGH): the REAL live message-send path
 *       (/conversations/message, conversation.ts) used to trust a
 *       client-supplied receiver for an existing thread; now always
 *       derived from the thread's own stored other-participant. Also
 *       covers the message-ownership.ts stock-CRUD fallback route.
 *  N1.3 BUG-NOTIF-003 (HIGH): offer accept/reject/counter notifications
 *       are now created server-side in updateByOfferId (never
 *       client-driven), and offer-created no longer double-fires.
 *  N1.4 FCM token cross-account race: registerPushToken now evicts a
 *       token from every OTHER profile before adding it to the caller's.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-notification-n1-security-fix-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-notification-n1-security-fix-test.db');
const PORT = 14176;
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

// ---------------------------------------------------------------------
// N1.1 — generic notification create is self-target-only
// ---------------------------------------------------------------------

test('N1.1: attacker cannot create a notification targeting an arbitrary victim by email', async () => {
  const attacker = await registerAndLogin(`n1-attacker-a-${randomUUID()}@test.local`);
  const victim = await registerAndLogin(`n1-victim-a-${randomUUID()}@test.local`);

  const res = await fetch(`${BASE_URL}/notifications`, {
    method: 'POST',
    headers: authed(attacker.jwt),
    body: JSON.stringify({
      data: { kind: 'offer', title: 'Sahte bildirim', message: 'saldiri', targetEmail: victim.email },
    }),
  });
  assert.equal(res.status, 403);

  const rows = await strapiInstance.db.query('api::notification.notification').findMany({
    where: { targetEmail: victim.email },
  } as any);
  assert.equal(rows.length, 0, 'the victim must have zero notification rows created by the attacker');
});

test('N1.1: attacker cannot create a notification targeting an arbitrary victim by profileId', async () => {
  const attacker = await registerAndLogin(`n1-attacker-b-${randomUUID()}@test.local`);
  const victim = await registerAndLogin(`n1-victim-b-${randomUUID()}@test.local`);

  const res = await fetch(`${BASE_URL}/notifications`, {
    method: 'POST',
    headers: authed(attacker.jwt),
    body: JSON.stringify({
      data: { kind: 'offer', title: 'Sahte bildirim', message: 'saldiri', targetProfileId: victim.ownerId },
    }),
  });
  assert.equal(res.status, 403);
});

test('N1.1: unauthenticated caller cannot create a notification at all', async () => {
  const res = await fetch(`${BASE_URL}/notifications`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: { kind: 'offer', title: 'x', message: 'y' } }),
  });
  assert.equal(res.status, 403);
});

test('N1.1: a self-targeted notification still works (own local-sync use case unaffected)', async () => {
  const user = await registerAndLogin(`n1-self-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/notifications`, {
    method: 'POST',
    headers: authed(user.jwt),
    body: JSON.stringify({
      data: { kind: 'broadcast_test', title: 'kendime', message: 'not', targetEmail: user.email },
    }),
  });
  assert.equal(res.status, 201);
  const row = await strapiInstance.db.query('api::notification.notification').findOne({
    where: { targetEmail: user.email, title: 'kendime' },
  } as any);
  assert.ok(row, 'the self-targeted notification must actually be created');
});

// ---------------------------------------------------------------------
// N1.1 — domain-event action: listing favorite/like
// ---------------------------------------------------------------------

async function createListingAs(jwt: string) {
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({
      data: { title: 'N1 Test Ilani', mainType: 'bitkisel', mode: 'sell', location: 'Konya' },
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

test('domain-event: favoriting a real listing notifies its real owner (not a client-supplied target)', async () => {
  const owner = await registerAndLogin(`n1-listing-owner-a-${randomUUID()}@test.local`);
  const fan = await registerAndLogin(`n1-listing-fan-a-${randomUUID()}@test.local`);
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
  assert.equal(row.senderEmail, fan.email);
});

test('domain-event: a spoofed targetEmail in the request body is ignored (recipient is server-derived)', async () => {
  const owner = await registerAndLogin(`n1-listing-owner-b-${randomUUID()}@test.local`);
  const attacker = await registerAndLogin(`n1-listing-attacker-b-${randomUUID()}@test.local`);
  const victim = await registerAndLogin(`n1-listing-victim-b-${randomUUID()}@test.local`);
  const listing = await createListingAs(owner.jwt);

  await domainEvent(attacker.jwt, {
    domain: 'listing',
    entityId: String(listing.documentId ?? listing.id),
    event: 'like',
    targetEmail: victim.email,
    title: 'Sahte',
    message: 'saldiri metni',
  });

  const victimRows = await strapiInstance.db.query('api::notification.notification').findMany({
    where: { targetEmail: victim.email },
  } as any);
  assert.equal(victimRows.length, 0, 'the victim must never receive a notification from this call');

  const ownerRow = await waitForRow(
    () =>
      strapiInstance.db.query('api::notification.notification').findOne({
        where: { targetEmail: owner.email, event: 'like', source: 'listing' },
      } as any),
    (r: any) => Boolean(r),
  );
  assert.notEqual(ownerRow.title, 'Sahte', 'title must be server-generated, not the client-supplied string');
});

test('domain-event: a nonexistent entityId is rejected, not silently no-op\'d', async () => {
  const user = await registerAndLogin(`n1-listing-nonexistent-${randomUUID()}@test.local`);
  const { status } = await domainEvent(user.jwt, {
    domain: 'listing',
    entityId: 'no-such-listing-ever',
    event: 'favorite',
  });
  assert.equal(status, 404);
});

test('domain-event: favoriting your own listing never notifies (self-interaction)', async () => {
  const owner = await registerAndLogin(`n1-listing-self-${randomUUID()}@test.local`);
  const listing = await createListingAs(owner.jwt);
  const { status, body } = await domainEvent(owner.jwt, {
    domain: 'listing',
    entityId: String(listing.documentId ?? listing.id),
    event: 'favorite',
  });
  assert.equal(status, 200);
  assert.equal(body.data?.skipped, 'self');
});

test('domain-event: invalid domain/event combination is rejected', async () => {
  const user = await registerAndLogin(`n1-domain-invalid-${randomUUID()}@test.local`);
  const { status } = await domainEvent(user.jwt, {
    domain: 'listing',
    entityId: 'whatever',
    event: 'not_a_real_event',
  });
  assert.equal(status, 400);
});

test('domain-event: retrying the identical interaction does not create a second row', async () => {
  const owner = await registerAndLogin(`n1-listing-owner-c-${randomUUID()}@test.local`);
  const fan = await registerAndLogin(`n1-listing-fan-c-${randomUUID()}@test.local`);
  const listing = await createListingAs(owner.jwt);
  const entityId = String(listing.documentId ?? listing.id);

  await domainEvent(fan.jwt, { domain: 'listing', entityId, event: 'like' });
  await waitForRow(
    () =>
      strapiInstance.db.query('api::notification.notification').findOne({
        where: { targetEmail: owner.email, event: 'like', source: 'listing' },
      } as any),
    (r: any) => Boolean(r),
  );
  await domainEvent(fan.jwt, { domain: 'listing', entityId, event: 'like' });

  const rows = await strapiInstance.db.query('api::notification.notification').findMany({
    where: { targetEmail: owner.email, event: 'like', source: 'listing' },
  } as any);
  assert.equal(rows.length, 1, 'a repeat of the same interaction by the same sender must not duplicate the row');
});

test('domain-event: profile favorite requires a REAL profile-setting row to exist', async () => {
  const fan = await registerAndLogin(`n1-profile-fan-${randomUUID()}@test.local`);
  const { status } = await domainEvent(fan.jwt, {
    domain: 'profile',
    entityId: 'u_totally_made_up_profile_id',
    event: 'favorite',
  });
  assert.equal(status, 404);
});

test('domain-event: profile comment notifies the real profile owner', async () => {
  const target = await registerAndLogin(`n1-profile-owner-${randomUUID()}@test.local`);
  const commenter = await registerAndLogin(`n1-profile-commenter-${randomUUID()}@test.local`);
  // A profile-setting row is created for `target` implicitly by registration
  // flows elsewhere in the app; ensure one exists here for the resolver.
  await strapiInstance.entityService.create('api::profile-setting.profile-setting', {
    data: { profileId: target.ownerId, ownerEmail: target.email },
  });

  const { status } = await domainEvent(commenter.jwt, {
    domain: 'profile',
    entityId: target.ownerId,
    event: 'comment',
  });
  assert.equal(status, 200);

  const row = await waitForRow(
    () =>
      strapiInstance.db.query('api::notification.notification').findOne({
        where: { targetProfileId: target.ownerId, event: 'comment', source: 'profile' },
      } as any),
    (r: any) => Boolean(r),
  );
  assert.equal(row.senderEmail, commenter.email);
});

// ---------------------------------------------------------------------
// N1.2 — message receiver is server-derived, not client-trusted
// ---------------------------------------------------------------------

async function sendConversationMessage(jwt: string, data: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/conversations/message`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('N1.2: a real listing-anchored first message resolves the receiver to the real listing owner, not a client claim', async () => {
  const owner = await registerAndLogin(`n1-msg-owner-a-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`n1-msg-buyer-a-${randomUUID()}@test.local`);
  const victim = await registerAndLogin(`n1-msg-victim-a-${randomUUID()}@test.local`);
  const listing = await createListingAs(owner.jwt);

  const { status, body } = await sendConversationMessage(buyer.jwt, {
    message: 'merhaba',
    listingId: String(listing.documentId ?? listing.id),
    receiverEmail: victim.email,
    receiverProfileId: victim.ownerId,
  });
  assert.equal(status, 200);
  assert.equal(body.data.receiverEmail, owner.email, 'receiver must be the REAL listing owner, not the attacker-claimed victim');
  assert.notEqual(body.data.receiverEmail, victim.email);
});

test('N1.2: a real thread participant cannot redirect a reply (and its notification) to an arbitrary third party', async () => {
  const b = await registerAndLogin(`n1-msg-hijack-b-${randomUUID()}@test.local`);
  const c = await registerAndLogin(`n1-msg-hijack-c-${randomUUID()}@test.local`);
  const victim = await registerAndLogin(`n1-msg-hijack-victim-${randomUUID()}@test.local`);
  const contextId = `listing-${randomUUID()}`;

  // Deliberately `contextId` (a pure conversation-grouping key), not
  // `listingId` -- these tests aren't about a real listing, and feeding a
  // non-real, digit-bearing string as `listingId` could otherwise
  // coincidentally collide with a real listing's numeric id elsewhere in
  // this shared test DB via resolveListingOwnerByAnyId's numeric-substring
  // fallback (a real hazard discovered while building this exact suite).
  const first = await sendConversationMessage(b.jwt, {
    message: 'ilk mesaj', contextId, receiverEmail: c.email,
  });
  assert.equal(first.status, 200);
  const threadId = first.body.thread.threadId;

  const reply = await sendConversationMessage(c.jwt, {
    message: 'yonlendirme denemesi',
    threadId,
    receiverEmail: victim.email,
    receiverProfileId: victim.ownerId,
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.data.receiverEmail, b.email, 'receiver must always be resolved from the real thread, never the claimed victim');
  assert.notEqual(reply.body.data.receiverEmail, victim.email);

  const victimNotifications = await strapiInstance.db.query('api::notification.notification').findMany({
    where: { targetEmail: victim.email },
  } as any);
  assert.equal(victimNotifications.length, 0, 'the third party must never receive a message notification from this hijack attempt');
});

test('N1.2: a non-participant is still rejected when reusing a real threadId (M1 regression)', async () => {
  const b = await registerAndLogin(`n1-msg-np-b-${randomUUID()}@test.local`);
  const c = await registerAndLogin(`n1-msg-np-c-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`n1-msg-np-stranger-${randomUUID()}@test.local`);
  const contextId = `listing-${randomUUID()}`;

  // Deliberately `contextId` (a pure conversation-grouping key), not
  // `listingId` -- these tests aren't about a real listing, and feeding a
  // non-real, digit-bearing string as `listingId` could otherwise
  // coincidentally collide with a real listing's numeric id elsewhere in
  // this shared test DB via resolveListingOwnerByAnyId's numeric-substring
  // fallback (a real hazard discovered while building this exact suite).
  const first = await sendConversationMessage(b.jwt, {
    message: 'ilk mesaj', contextId, receiverEmail: c.email,
  });
  const threadId = first.body.thread.threadId;

  const hijack = await sendConversationMessage(stranger.jwt, {
    message: 'saldiri', threadId, receiverEmail: 'someone@test.local',
  });
  assert.equal(hijack.status, 403);
});

test('N1.2: a genuine participant can still reply normally (no regression)', async () => {
  const b = await registerAndLogin(`n1-msg-reply-b-${randomUUID()}@test.local`);
  const c = await registerAndLogin(`n1-msg-reply-c-${randomUUID()}@test.local`);
  const contextId = `listing-${randomUUID()}`;

  // Deliberately `contextId` (a pure conversation-grouping key), not
  // `listingId` -- these tests aren't about a real listing, and feeding a
  // non-real, digit-bearing string as `listingId` could otherwise
  // coincidentally collide with a real listing's numeric id elsewhere in
  // this shared test DB via resolveListingOwnerByAnyId's numeric-substring
  // fallback (a real hazard discovered while building this exact suite).
  const first = await sendConversationMessage(b.jwt, {
    message: 'ilk mesaj', contextId, receiverEmail: c.email,
  });
  const threadId = first.body.thread.threadId;

  const reply = await sendConversationMessage(c.jwt, {
    message: 'cevap', threadId, receiverEmail: b.email,
  });
  assert.equal(reply.status, 200);
  assert.equal(reply.body.data.senderEmail, c.email);
  assert.equal(reply.body.thread.threadId, threadId);
});

test('N1.2 (stock-CRUD fallback route): message-ownership.ts also rejects an unverifiable receiver', async () => {
  const requester = await registerAndLogin(`n1-fallback-req-${randomUUID()}@test.local`);
  const victim = await registerAndLogin(`n1-fallback-victim-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/messages`, {
    method: 'POST',
    headers: authed(requester.jwt),
    body: JSON.stringify({
      data: { message: 'hello', receiverEmail: victim.email, receiverProfileId: victim.ownerId },
    }),
  });
  assert.equal(res.status, 403, 'no threadId and no resolvable listing means the receiver cannot be verified');
});

// ---------------------------------------------------------------------
// N1.3 — offer notifications are server-authoritative, exactly one per event
// ---------------------------------------------------------------------

async function createOffer(jwt: string, data: Record<string, unknown>) {
  const res = await fetch(`${BASE_URL}/offers`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ data }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const notificationsFor = (email: string, event: string) =>
  strapiInstance.db.query('api::notification.notification').findMany({
    where: { targetEmail: email, event, source: 'offer' } as any,
  });

test('N1.3: offer created produces exactly one notification for the real listing owner (no client-side duplicate)', async () => {
  const owner = await registerAndLogin(`n1-offer-owner-a-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`n1-offer-buyer-a-${randomUUID()}@test.local`);
  const listing = await createListingAs(owner.jwt);

  const offerId = `offer_${randomUUID()}`;
  const { status } = await createOffer(buyer.jwt, {
    offerId, listingId: String(listing.documentId ?? listing.id), title: listing.title,
  });
  assert.equal(status, 201);

  const rows = await waitForRow(
    () => notificationsFor(owner.email, 'created'),
    (r: any[]) => r.length > 0,
  );
  assert.equal(rows.length, 1);
});

test('N1.3: offer accepted notifies the requester exactly once, from the real offer row', async () => {
  const owner = await registerAndLogin(`n1-offer-owner-b-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`n1-offer-buyer-b-${randomUUID()}@test.local`);
  const listing = await createListingAs(owner.jwt);
  const offerId = `offer_${randomUUID()}`;
  await createOffer(buyer.jwt, { offerId, listingId: String(listing.documentId ?? listing.id), title: listing.title });

  const res = await fetch(`${BASE_URL}/offers/${offerId}/by-offer-id`, {
    method: 'PATCH',
    headers: authed(owner.jwt),
    body: JSON.stringify({ data: { offerStatus: 'accepted' } }),
  });
  assert.equal(res.status, 200);

  const rows = await waitForRow(
    () => notificationsFor(buyer.email, 'accepted'),
    (r: any[]) => r.length > 0,
  );
  assert.equal(rows.length, 1);
});

test('N1.3: retrying the same status update does not duplicate the notification (idempotent)', async () => {
  const owner = await registerAndLogin(`n1-offer-owner-c-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`n1-offer-buyer-c-${randomUUID()}@test.local`);
  const listing = await createListingAs(owner.jwt);
  const offerId = `offer_${randomUUID()}`;
  await createOffer(buyer.jwt, { offerId, listingId: String(listing.documentId ?? listing.id), title: listing.title });

  await fetch(`${BASE_URL}/offers/${offerId}/by-offer-id`, {
    method: 'PATCH', headers: authed(owner.jwt), body: JSON.stringify({ data: { offerStatus: 'rejected' } }),
  });
  await waitForRow(() => notificationsFor(buyer.email, 'rejected'), (r: any[]) => r.length > 0);
  // Retry the identical status update (idempotent client retry scenario).
  await fetch(`${BASE_URL}/offers/${offerId}/by-offer-id`, {
    method: 'PATCH', headers: authed(owner.jwt), body: JSON.stringify({ data: { offerStatus: 'rejected' } }),
  });

  const rows = await notificationsFor(buyer.email, 'rejected');
  assert.equal(rows.length, 1, 'a retried status update must not create a second notification row');
});

test('N1.3: counter-offer notifies whichever participant did NOT make the call', async () => {
  const owner = await registerAndLogin(`n1-offer-owner-d-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`n1-offer-buyer-d-${randomUUID()}@test.local`);
  const listing = await createListingAs(owner.jwt);
  const offerId = `offer_${randomUUID()}`;
  await createOffer(buyer.jwt, { offerId, listingId: String(listing.documentId ?? listing.id), title: listing.title });

  // Owner (receiver) counters -> requester (buyer) must be notified.
  await fetch(`${BASE_URL}/offers/${offerId}/by-offer-id`, {
    method: 'PATCH', headers: authed(owner.jwt), body: JSON.stringify({ data: { offerStatus: 'bargaining' } }),
  });
  const rows = await waitForRow(() => notificationsFor(buyer.email, 'bargaining'), (r: any[]) => r.length > 0);
  assert.equal(rows.length, 1);
  const ownerRows = await notificationsFor(owner.email, 'bargaining');
  assert.equal(ownerRows.length, 0, 'the caller must never be notified about their own action');
});

// ---------------------------------------------------------------------
// N1.4 — FCM token ownership is server-authoritative across account switch
// ---------------------------------------------------------------------

async function fcmTokensFor(profileId: string): Promise<string[]> {
  const row = await strapiInstance.db.query('api::profile-setting.profile-setting').findOne({
    where: { profileId },
  } as any);
  const raw = row?.fcmTokens;
  return Array.isArray(raw) ? raw.map((t: unknown) => String(t)) : [];
}

test('N1.4: registering a token to user B evicts it from user A (shared-device account switch)', async () => {
  const a = await registerAndLogin(`n1-fcm-a-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`n1-fcm-b-${randomUUID()}@test.local`);
  const sharedToken = `fcm-token-${randomUUID()}`;

  const regA = await fetch(`${BASE_URL}/auth/register-push-token`, {
    method: 'POST', headers: authed(a.jwt), body: JSON.stringify({ token: sharedToken }),
  });
  assert.equal(regA.status, 200);
  assert.ok((await fcmTokensFor(a.ownerId)).includes(sharedToken));

  const regB = await fetch(`${BASE_URL}/auth/register-push-token`, {
    method: 'POST', headers: authed(b.jwt), body: JSON.stringify({ token: sharedToken }),
  });
  assert.equal(regB.status, 200);

  assert.ok((await fcmTokensFor(b.ownerId)).includes(sharedToken), 'B must now own the token');
  assert.ok(!(await fcmTokensFor(a.ownerId)).includes(sharedToken), 'A must no longer have the token -- no cross-delivery to B\'s device');
});

test('N1.4: repeated registration of the same token by the same user is idempotent (no duplicate entries)', async () => {
  const user = await registerAndLogin(`n1-fcm-idempotent-${randomUUID()}@test.local`);
  const token = `fcm-token-${randomUUID()}`;
  await fetch(`${BASE_URL}/auth/register-push-token`, {
    method: 'POST', headers: authed(user.jwt), body: JSON.stringify({ token }),
  });
  await fetch(`${BASE_URL}/auth/register-push-token`, {
    method: 'POST', headers: authed(user.jwt), body: JSON.stringify({ token }),
  });
  const tokens = await fcmTokensFor(user.ownerId);
  assert.equal(tokens.filter((t) => t === token).length, 1);
});

test('N1.4: a different token for the same user does not evict the user\'s own other tokens (multi-device)', async () => {
  const user = await registerAndLogin(`n1-fcm-multidevice-${randomUUID()}@test.local`);
  const tokenA = `fcm-token-${randomUUID()}`;
  const tokenB = `fcm-token-${randomUUID()}`;
  await fetch(`${BASE_URL}/auth/register-push-token`, {
    method: 'POST', headers: authed(user.jwt), body: JSON.stringify({ token: tokenA }),
  });
  await fetch(`${BASE_URL}/auth/register-push-token`, {
    method: 'POST', headers: authed(user.jwt), body: JSON.stringify({ token: tokenB }),
  });
  const tokens = await fcmTokensFor(user.ownerId);
  assert.ok(tokens.includes(tokenA));
  assert.ok(tokens.includes(tokenB));
});
