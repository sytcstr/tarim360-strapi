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
