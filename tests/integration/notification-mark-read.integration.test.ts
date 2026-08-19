/**
 * PERMISSION_GAP_S5A — notification.markRead permission-gap fix.
 *
 * Root cause (PERMISSION_GAP_RELEASE_AUDIT.md, PERM-N1): `PATCH
 * /notifications/:notificationId/read` uses `auth: { scope: [] }` but
 * `api::notification.notification.markRead` was never added to
 * src/index.ts's `authenticatedActions` bootstrap array, so every call
 * 403'd at the Strapi policy layer before ever reaching the controller
 * -- regardless of who called it. The controller's own ownership check
 * (owner-match OR broadcast bypass) was already correct; only the
 * permission grant was missing. This suite proves both halves: the
 * route is now reachable, and the pre-existing ownership check still
 * blocks cross-user access exactly as before.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-notification-mark-read-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-notification-mark-read-test.db');
const PORT = 14166;
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

async function registerAndLogin(email: string): Promise<{ jwt: string; ownerId: string }> {
  const res = await fetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  const json = await res.json();
  const ownerId = `u_${email.trim().toLowerCase().replace(/[^a-z0-9]/g, '_')}`;
  return { jwt: json.jwt, ownerId };
}

const authed = (jwt: string) => ({ authorization: `Bearer ${jwt}`, 'content-type': 'application/json' });

async function createNotification(overrides: Record<string, unknown>) {
  return strapiInstance.entityService.create('api::notification.notification', {
    data: {
      notificationId: `n_${randomUUID()}`,
      kind: 'test',
      title: 'Test bildirimi',
      message: 'Test mesaji',
      isRead: false,
      ...overrides,
    },
  });
}

const countRowsWithNotificationId = async (notificationId: string) => {
  const rows = await strapiInstance.db.query('api::notification.notification').findMany({
    where: { notificationId },
  } as any);
  return Array.isArray(rows) ? rows.length : 0;
};

test('owner (matched by receiverEmail) can mark their own notification read -> 200', async () => {
  const owner = await registerAndLogin(`notif-owner2-${randomUUID()}@test.local`);
  const meRes = await fetch(`${BASE_URL}/users/me`, { headers: authed(owner.jwt) });
  const me = await meRes.json();
  const own = await createNotification({ receiverEmail: me.email });
  const res = await fetch(`${BASE_URL}/notifications/${own.notificationId}/read`, {
    method: 'PATCH',
    headers: authed(owner.jwt),
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200, 'permission gap must be closed: owner should reach the controller and succeed');
  const body = await res.json();
  assert.equal(body.data.ok, true);
  const row = await strapiInstance.entityService.findOne('api::notification.notification', own.id);
  assert.equal(row.isRead, true);
});

test('a non-owner given another user\'s notification id is rejected -> 403 (authorization, not just permission)', async () => {
  const owner = await registerAndLogin(`notif-victim-${randomUUID()}@test.local`);
  const ownerMeRes = await fetch(`${BASE_URL}/users/me`, { headers: authed(owner.jwt) });
  const ownerMe = await ownerMeRes.json();
  const victimNotif = await createNotification({ receiverEmail: ownerMe.email });

  const attacker = await registerAndLogin(`notif-attacker-${randomUUID()}@test.local`);
  const res = await fetch(`${BASE_URL}/notifications/${victimNotif.notificationId}/read`, {
    method: 'PATCH',
    headers: authed(attacker.jwt),
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 403, 'a stranger must not be able to mark someone else\'s private notification read');
  const row = await strapiInstance.entityService.findOne('api::notification.notification', victimNotif.id);
  assert.equal(row.isRead, false, 'the victim\'s notification must remain unread');
});

test('an unauthenticated caller is rejected', async () => {
  // 403, not 401: a request with no JWT never reaches the controller --
  // Strapi's own authorize middleware (route config auth:{scope:[]})
  // rejects it first, treating the caller as the "public" role, which
  // does not have this action enabled. Same documented platform
  // behavior as engagement.integration.test.ts's identical case.
  const notif = await createNotification({ receiverEmail: 'someone@test.local' });
  const res = await fetch(`${BASE_URL}/notifications/${notif.notificationId}/read`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 403);
});

test('marking the same notification read twice is idempotent and does not create a duplicate row', async () => {
  const owner = await registerAndLogin(`notif-idem-${randomUUID()}@test.local`);
  const meRes = await fetch(`${BASE_URL}/users/me`, { headers: authed(owner.jwt) });
  const me = await meRes.json();
  const notif = await createNotification({ receiverEmail: me.email });

  const first = await fetch(`${BASE_URL}/notifications/${notif.notificationId}/read`, {
    method: 'PATCH',
    headers: authed(owner.jwt),
    body: JSON.stringify({}),
  });
  assert.equal(first.status, 200);

  const second = await fetch(`${BASE_URL}/notifications/${notif.notificationId}/read`, {
    method: 'PATCH',
    headers: authed(owner.jwt),
    body: JSON.stringify({}),
  });
  assert.equal(second.status, 200, 'marking an already-read notification read again must still succeed safely');
  const body = await second.json();
  assert.equal(body.data.ok, true);

  const count = await countRowsWithNotificationId(notif.notificationId);
  assert.equal(count, 1, 'no duplicate row should exist for the same notificationId after two markRead calls');
});

test('a broadcast notification can be marked read by any authenticated user (intentional bypass, unaffected by this fix)', async () => {
  const anyUser = await registerAndLogin(`notif-broadcast-${randomUUID()}@test.local`);
  const broadcast = await createNotification({ broadcast: true });
  const res = await fetch(`${BASE_URL}/notifications/${broadcast.notificationId}/read`, {
    method: 'PATCH',
    headers: authed(anyUser.jwt),
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 200);
});
