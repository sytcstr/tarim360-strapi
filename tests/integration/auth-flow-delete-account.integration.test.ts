/**
 * PERMISSION_GAP_S5A — auth-flow.deleteAccount permission-gap fix.
 *
 * Root cause (PERMISSION_GAP_RELEASE_AUDIT.md, PERM-N2): `DELETE
 * /auth/account` uses `auth: { scope: [] }` but
 * `api::auth-flow.auth-flow.deleteAccount` was never added to
 * src/index.ts's `authenticatedActions` bootstrap array, so the "Hesabi
 * ve Verileri Sil" button always 403'd for every user before ever
 * reaching the controller. The controller itself was already
 * self-only and non-spoofable (userId/email/ownerId are all read from
 * ctx.state.user -- the authenticated session -- never from the
 * request body), so this suite proves: (1) the route is now reachable
 * and actually deletes the caller's own account + owned data, (2) a
 * caller cannot influence which account gets deleted via the request
 * body, (3) another user's account/data is left untouched, (4)
 * unauthenticated calls are rejected.
 *
 * Uses an isolated throwaway SQLite file (see before() below) -- no
 * real/production database or account is touched by this suite.
 *
 * Run: npm run test:integration (real Strapi boot against a throwaway
 * SQLite file).
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-auth-flow-delete-account-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-auth-flow-delete-account-test.db');
const PORT = 14167;
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

async function registerAndLogin(
  email: string,
): Promise<{ jwt: string; ownerId: string; userId: number; email: string }> {
  const res = await fetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  const json = await res.json();
  const ownerId = `u_${email.trim().toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
  return { jwt: json.jwt, ownerId, userId: json.user.id, email: email.trim().toLowerCase() };
}

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

const findUserById = (userId: number) =>
  strapiInstance.db.query('plugin::users-permissions.user').findOne({ where: { id: userId } } as any);

async function createListingAs(jwt: string) {
  const res = await fetch(`${BASE_URL}/listings`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({
      data: { title: 'N2 Delete Test Ilani', mainType: 'bitkisel', mode: 'sell', location: 'Konya', operationId: randomUUID() },
    }),
  });
  const json = await res.json();
  return json.data;
}

async function createListingCommentAs(jwt: string, listingId: string, text = 'Test yorumu') {
  const operationId = randomUUID();
  const res = await fetch(`${BASE_URL}/listing-comments`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({
      data: { listingId, body: text, operationId },
    }),
  });
  if (res.status !== 201) throw new Error(`listing-comment create failed: ${res.status}`);
  // The route's sanitizeOutput strips the response body down to {} for the
  // authenticated role (a separate, pre-existing response-shape quirk, not
  // part of this fix) -- look the real row up directly instead of trusting
  // the HTTP response body.
  return strapiInstance.db
    .query('api::listing-comment.listing-comment')
    .findOne({ where: { operationId } } as any);
}

test('an authenticated user can delete their own account -> 200, user row removed, retention record created', async () => {
  const user = await registerAndLogin(`delacc-self-${randomUUID()}@test.local`);
  await strapiInstance.entityService.create('api::notification.notification', {
    data: { notificationId: `n_${randomUUID()}`, receiverEmail: user.email, isRead: false },
  });

  const res = await fetch(`${BASE_URL}/auth/account`, {
    method: 'DELETE',
    headers: authed(user.jwt),
  });
  assert.equal(res.status, 200, 'permission gap must be closed: own account deletion should succeed');
  const body = await res.json();
  assert.equal(body.ok, true);

  const userRow = await findUserById(user.userId);
  assert.equal(userRow, null, 'the users-permissions row must be gone after self-deletion');

  const records = await strapiInstance.db.query('api::deleted-account-record.deleted-account-record').findMany({
    where: { ownerId: user.ownerId },
  } as any);
  assert.equal(records.length, 1, 'a 15-day retention record must be created for the deletion');
  assert.equal(records[0].email, user.email);

  const notifs = await strapiInstance.db.query('api::notification.notification').findMany({
    where: { receiverEmail: user.email },
  } as any);
  assert.equal(notifs.length, 0, 'the deleted user\'s own notifications must be cleaned up');
});

test('an unauthenticated caller is rejected, no data is touched', async () => {
  // 403, not 401: a request with no JWT never reaches the controller --
  // Strapi's own authorize middleware (route config auth:{scope:[]})
  // rejects it first, treating the caller as the "public" role, which
  // does not have this action enabled. Same documented platform
  // behavior as engagement.integration.test.ts's identical case.
  const res = await fetch(`${BASE_URL}/auth/account`, { method: 'DELETE' });
  assert.equal(res.status, 403);
});

test('a request body claiming a different userId/email cannot redirect the deletion target (non-spoofable)', async () => {
  const caller = await registerAndLogin(`delacc-caller-${randomUUID()}@test.local`);
  const victim = await registerAndLogin(`delacc-victim-${randomUUID()}@test.local`);

  const res = await fetch(`${BASE_URL}/auth/account`, {
    method: 'DELETE',
    headers: authed(caller.jwt),
    body: JSON.stringify({
      userId: victim.userId,
      id: victim.userId,
      email: victim.email,
      profileId: victim.ownerId,
    }),
  });
  assert.equal(res.status, 200);

  const callerRow = await findUserById(caller.userId);
  assert.equal(callerRow, null, 'the caller\'s own account must be the one actually deleted');

  const victimRow = await findUserById(victim.userId);
  assert.notEqual(victimRow, null, 'the victim account named in the request body must be untouched');
  assert.equal(victimRow.email, victim.email);
});

test('deleting one account does not remove another user\'s data', async () => {
  const toDelete = await registerAndLogin(`delacc-target-${randomUUID()}@test.local`);
  const bystander = await registerAndLogin(`delacc-bystander-${randomUUID()}@test.local`);
  await strapiInstance.entityService.create('api::notification.notification', {
    data: { notificationId: `n_${randomUUID()}`, receiverEmail: bystander.email, isRead: false },
  });

  const res = await fetch(`${BASE_URL}/auth/account`, {
    method: 'DELETE',
    headers: authed(toDelete.jwt),
  });
  assert.equal(res.status, 200);

  const bystanderRow = await findUserById(bystander.userId);
  assert.notEqual(bystanderRow, null, 'an unrelated user\'s account must survive another user\'s self-deletion');

  const bystanderNotifs = await strapiInstance.db.query('api::notification.notification').findMany({
    where: { receiverEmail: bystander.email },
  } as any);
  assert.equal(bystanderNotifs.length, 1, 'an unrelated user\'s notifications must survive another user\'s self-deletion');
});

// ---------------------------------------------------------------------
// NOTIFICATION_N2_ACCOUNT_DELETION_FIX_REPORT.md — BUG-NOTIF-005.
// N1's own new producers (offer.ts create/updateByOfferId,
// notification.ts createDomainEvent) write targetEmail/targetProfileId,
// which the pre-existing cleanup filter (ownerProfileId/receiverEmail/
// requesterEmail) never covered -- these rows survived account deletion
// as orphaned PII. These tests exercise the REAL producers directly
// (not hand-crafted rows) to prove the fix reaches the actual shape
// each one writes.
// ---------------------------------------------------------------------

test('a notification reachable only via targetEmail is removed on account deletion', async () => {
  const user = await registerAndLogin(`delacc-target-email-${randomUUID()}@test.local`);
  await strapiInstance.entityService.create('api::notification.notification', {
    data: { notificationId: `n_${randomUUID()}`, targetEmail: user.email, isRead: false },
  });

  const res = await fetch(`${BASE_URL}/auth/account`, { method: 'DELETE', headers: authed(user.jwt) });
  assert.equal(res.status, 200);

  const rows = await strapiInstance.db.query('api::notification.notification').findMany({
    where: { targetEmail: user.email },
  } as any);
  assert.equal(rows.length, 0, 'a targetEmail-only notification must be cleaned up');
});

test('a notification reachable only via targetProfileId is removed on account deletion', async () => {
  const user = await registerAndLogin(`delacc-target-pid-${randomUUID()}@test.local`);
  await strapiInstance.entityService.create('api::notification.notification', {
    data: { notificationId: `n_${randomUUID()}`, targetProfileId: user.ownerId, isRead: false },
  });

  const res = await fetch(`${BASE_URL}/auth/account`, { method: 'DELETE', headers: authed(user.jwt) });
  assert.equal(res.status, 200);

  const rows = await strapiInstance.db.query('api::notification.notification').findMany({
    where: { targetProfileId: user.ownerId },
  } as any);
  assert.equal(rows.length, 0, 'a targetProfileId-only notification must be cleaned up');
});

test('a real offer notification (offer.create, targetEmail-shaped) is removed when the receiver deletes their account', async () => {
  const owner = await registerAndLogin(`delacc-offer-owner-${randomUUID()}@test.local`);
  const buyer = await registerAndLogin(`delacc-offer-buyer-${randomUUID()}@test.local`);
  const listing = await createListingAs(owner.jwt);

  const offerId = `offer_${randomUUID()}`;
  await fetch(`${BASE_URL}/offers`, {
    method: 'POST',
    headers: authed(buyer.jwt),
    body: JSON.stringify({
      data: { offerId, listingId: String(listing.documentId ?? listing.id), title: listing.title },
    }),
  });
  const before = await strapiInstance.db.query('api::notification.notification').findMany({
    where: { targetEmail: owner.email, source: 'offer' },
  } as any);
  assert.ok(before.length > 0, 'sanity check: offer.create must have produced a targetEmail-shaped notification for the owner');

  const res = await fetch(`${BASE_URL}/auth/account`, { method: 'DELETE', headers: authed(owner.jwt) });
  assert.equal(res.status, 200);

  const after = await strapiInstance.db.query('api::notification.notification').findMany({
    where: { targetEmail: owner.email, source: 'offer' },
  } as any);
  assert.equal(after.length, 0, 'the real offer notification must be cleaned up, not just a hand-crafted row');
});

test('a real domain-event notification (listing favorite) is removed when the target owner deletes their account', async () => {
  const owner = await registerAndLogin(`delacc-domain-owner-${randomUUID()}@test.local`);
  const fan = await registerAndLogin(`delacc-domain-fan-${randomUUID()}@test.local`);
  const listing = await createListingAs(owner.jwt);

  await fetch(`${BASE_URL}/notifications/domain-event`, {
    method: 'POST',
    headers: authed(fan.jwt),
    body: JSON.stringify({
      domain: 'listing',
      entityId: String(listing.documentId ?? listing.id),
      event: 'favorite',
    }),
  });
  const before = await strapiInstance.db.query('api::notification.notification').findMany({
    where: { targetEmail: owner.email, source: 'listing' },
  } as any);
  assert.ok(before.length > 0, 'sanity check: the domain-event action must have produced a targetEmail-shaped notification for the owner');

  const res = await fetch(`${BASE_URL}/auth/account`, { method: 'DELETE', headers: authed(owner.jwt) });
  assert.equal(res.status, 200);

  const after = await strapiInstance.db.query('api::notification.notification').findMany({
    where: { targetEmail: owner.email, source: 'listing' },
  } as any);
  assert.equal(after.length, 0, 'the real domain-event notification must be cleaned up');
});

test('a message-shaped notification (receiverEmail) cleanup behavior is unchanged by this fix', async () => {
  const user = await registerAndLogin(`delacc-message-shape-${randomUUID()}@test.local`);
  await strapiInstance.entityService.create('api::notification.notification', {
    data: { notificationId: `n_${randomUUID()}`, receiverEmail: user.email, isRead: false },
  });

  const res = await fetch(`${BASE_URL}/auth/account`, { method: 'DELETE', headers: authed(user.jwt) });
  assert.equal(res.status, 200);

  const rows = await strapiInstance.db.query('api::notification.notification').findMany({
    where: { receiverEmail: user.email },
  } as any);
  assert.equal(rows.length, 0, 'pre-existing receiverEmail-based cleanup must still work exactly as before');
});

test('another user\'s targetEmail/targetProfileId notification survives this account\'s deletion', async () => {
  const toDelete = await registerAndLogin(`delacc-scope-a-${randomUUID()}@test.local`);
  const bystander = await registerAndLogin(`delacc-scope-b-${randomUUID()}@test.local`);
  await strapiInstance.entityService.create('api::notification.notification', {
    data: {
      notificationId: `n_${randomUUID()}`,
      targetEmail: bystander.email,
      targetProfileId: bystander.ownerId,
      isRead: false,
    },
  });

  const res = await fetch(`${BASE_URL}/auth/account`, { method: 'DELETE', headers: authed(toDelete.jwt) });
  assert.equal(res.status, 200);

  const rows = await strapiInstance.db.query('api::notification.notification').findMany({
    where: { targetEmail: bystander.email },
  } as any);
  assert.equal(rows.length, 1, 'the new targetEmail/targetProfileId filter must not delete an unrelated user\'s notification');
});

test('an unrelated notification (no field referencing the deleted account at all) is left untouched', async () => {
  const toDelete = await registerAndLogin(`delacc-unrelated-${randomUUID()}@test.local`);
  const stranger = await registerAndLogin(`delacc-stranger-${randomUUID()}@test.local`);
  await strapiInstance.entityService.create('api::notification.notification', {
    data: {
      notificationId: `n_${randomUUID()}`,
      targetEmail: stranger.email,
      targetProfileId: stranger.ownerId,
      senderEmail: 'someone-else@test.local',
      isRead: false,
    },
  });

  const res = await fetch(`${BASE_URL}/auth/account`, { method: 'DELETE', headers: authed(toDelete.jwt) });
  assert.equal(res.status, 200);

  const rows = await strapiInstance.db.query('api::notification.notification').findMany({
    where: { targetEmail: stranger.email },
  } as any);
  assert.equal(rows.length, 1, 'a notification with no field referencing the deleted account must be untouched');
});

// ---------------------------------------------------------------------
// ENGAGEMENT_E2_TARGETED_FIX_REPORT.md BUG-ENG-013: listing-comment rows
// were never part of this cleanup cascade, leaving a deleted user's
// ownerEmail (PII) orphaned on their comments indefinitely -- same class
// of gap as the notification PII retention fix above.
// ---------------------------------------------------------------------

test('BUG-ENG-013: A comments on a listing, then deletes their account -> the comment row is removed', async () => {
  const owner = await registerAndLogin(`delacc-comment-owner-${randomUUID()}@test.local`);
  const listing = await createListingAs(owner.jwt);
  const commenter = await registerAndLogin(`delacc-comment-a-${randomUUID()}@test.local`);
  const comment = await createListingCommentAs(commenter.jwt, listing.listingNo ?? listing.id);

  const res = await fetch(`${BASE_URL}/auth/account`, { method: 'DELETE', headers: authed(commenter.jwt) });
  assert.equal(res.status, 200);

  const row = await strapiInstance.db.query('api::listing-comment.listing-comment').findOne({
    where: { id: comment.id },
  } as any);
  assert.equal(row, null, 'the deleted user\'s comment row must be gone, not just soft-marked');
});

test('BUG-ENG-013: B\'s comment on the same listing survives A\'s account deletion', async () => {
  const owner = await registerAndLogin(`delacc-comment-owner2-${randomUUID()}@test.local`);
  const listing = await createListingAs(owner.jwt);
  const a = await registerAndLogin(`delacc-comment-a2-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`delacc-comment-b2-${randomUUID()}@test.local`);
  await createListingCommentAs(a.jwt, listing.listingNo ?? listing.id, 'A yorumu');
  const bComment = await createListingCommentAs(b.jwt, listing.listingNo ?? listing.id, 'B yorumu');

  const res = await fetch(`${BASE_URL}/auth/account`, { method: 'DELETE', headers: authed(a.jwt) });
  assert.equal(res.status, 200);

  const row = await strapiInstance.db.query('api::listing-comment.listing-comment').findOne({
    where: { id: bComment.id },
  } as any);
  assert.ok(row, 'B\'s comment must survive A\'s account deletion');
  assert.equal(row.body, 'B yorumu');
});

test('BUG-ENG-013: an unrelated comment on a different listing by a different owner is untouched', async () => {
  const owner1 = await registerAndLogin(`delacc-comment-owner3-${randomUUID()}@test.local`);
  const listing1 = await createListingAs(owner1.jwt);
  const a = await registerAndLogin(`delacc-comment-a3-${randomUUID()}@test.local`);
  await createListingCommentAs(a.jwt, listing1.listingNo ?? listing1.id, 'A yorumu');

  const owner2 = await registerAndLogin(`delacc-comment-owner4-${randomUUID()}@test.local`);
  const listing2 = await createListingAs(owner2.jwt);
  const stranger = await registerAndLogin(`delacc-comment-stranger-${randomUUID()}@test.local`);
  const strangerComment = await createListingCommentAs(stranger.jwt, listing2.listingNo ?? listing2.id, 'Alakasiz yorum');

  const res = await fetch(`${BASE_URL}/auth/account`, { method: 'DELETE', headers: authed(a.jwt) });
  assert.equal(res.status, 200);

  const row = await strapiInstance.db.query('api::listing-comment.listing-comment').findOne({
    where: { id: strangerComment.id },
  } as any);
  assert.ok(row, 'a comment from an entirely unrelated user/listing must be untouched');
});

test('BUG-ENG-013: after cleanup, only the remaining (non-deleted-owner) comment row is left for that listing', async () => {
  const owner = await registerAndLogin(`delacc-comment-owner5-${randomUUID()}@test.local`);
  const listing = await createListingAs(owner.jwt);
  const a = await registerAndLogin(`delacc-comment-a5-${randomUUID()}@test.local`);
  const b = await registerAndLogin(`delacc-comment-b5-${randomUUID()}@test.local`);
  const aComment = await createListingCommentAs(a.jwt, listing.listingNo ?? listing.id, 'A yorumu');
  const bComment = await createListingCommentAs(b.jwt, listing.listingNo ?? listing.id, 'B yorumu');

  const res = await fetch(`${BASE_URL}/auth/account`, { method: 'DELETE', headers: authed(a.jwt) });
  assert.equal(res.status, 200);

  const remaining = await strapiInstance.db.query('api::listing-comment.listing-comment').findMany({
    where: { listingId: aComment.listingId },
  } as any);
  assert.equal(remaining.length, 1, 'exactly one comment (B\'s) must remain for this listing after A\'s cleanup');
  assert.equal(remaining[0].id, bComment.id);
});

test('BUG-ENG-013 regression: notification cleanup still works correctly alongside the new listing-comment cleanup', async () => {
  const user = await registerAndLogin(`delacc-comment-notif-${randomUUID()}@test.local`);
  await strapiInstance.entityService.create('api::notification.notification', {
    data: { notificationId: `n_${randomUUID()}`, receiverEmail: user.email, isRead: false },
  });
  const listing = await createListingAs(user.jwt);
  await createListingCommentAs(user.jwt, listing.listingNo ?? listing.id);

  const res = await fetch(`${BASE_URL}/auth/account`, { method: 'DELETE', headers: authed(user.jwt) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);

  const notifRows = await strapiInstance.db.query('api::notification.notification').findMany({
    where: { receiverEmail: user.email },
  } as any);
  assert.equal(notifRows.length, 0, 'notification cleanup must be unaffected by the listing-comment cleanup addition');
});

test('BUG-ENG-013 regression: account deletion permission still works end-to-end (no permission regression)', async () => {
  const user = await registerAndLogin(`delacc-comment-perm-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/auth/account`, { method: 'DELETE', headers: authed(user.jwt) });
  assert.equal(res.status, 200, 'permission-gap fix (PERM-N2) must remain intact after the listing-comment cleanup addition');
  const userRow = await findUserById(user.userId);
  assert.equal(userRow, null);
});
