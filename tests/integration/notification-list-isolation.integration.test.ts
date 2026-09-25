/**
 * Full-app reconciliation (measured in production): GET /notifications by a
 * brand-new signed-in user returned OTHER users' notifications (43 rows, real
 * emails and message previews). A user must only ever list their own
 * notifications plus real broadcasts.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-notification-list-isolation-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-notification-list-isolation-test.db');
const PORT = 14265;
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

const register = async (email: string) => {
  const res = await fetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  return (await res.json()).jwt as string;
};

const list = async (jwt: string, qs = '') => {
  const res = await fetch(`${BASE_URL}/notifications${qs}`, { headers: { authorization: `Bearer ${jwt}` } });
  return { status: res.status, body: await res.json() };
};

test('a user lists only their own notifications, never another user\'s', async () => {
  const victim = `victim-${randomUUID()}@test.local`;
  const viewer = `viewer-${randomUUID()}@test.local`;
  await register(victim);
  const viewerJwt = await register(viewer);

  const seed = async (targetEmail: string, title: string, kind = 'message') =>
    strapiInstance.entityService.create('api::notification.notification', {
      data: {
        notificationId: randomUUID(),
        kind,
        title,
        message: `secret preview for ${targetEmail}`,
        targetEmail,
        targetProfileId: `u_${targetEmail.replace(/[^a-z0-9]/g, '_')}`,
        publishedAt: new Date().toISOString(),
      },
    });
  await seed(victim, 'victim-only');
  await seed(viewer, 'viewer-own');

  for (const qs of ['', '?pagination[pageSize]=100', '?sort=createdAt:desc&pagination[page]=1&pagination[pageSize]=25']) {
    const r = await list(viewerJwt, qs);
    assert.equal(r.status, 200);
    const titles = (r.body.data ?? []).map((n: any) => n.title);
    assert.ok(titles.includes('viewer-own'), `own notification missing (${qs}): ${JSON.stringify(titles)}`);
    assert.equal(titles.includes('victim-only'), false, `foreign notification leaked (${qs})`);
    assert.equal(JSON.stringify(r.body).includes(victim), false, `victim email leaked (${qs})`);
  }
});

// mergeScopeOrFilter is shared by the message, thread, offer and support-ticket
// policies: they all leaked the same way (measured in production: 18 messages
// and 5 threads of real conversations visible to any signed-in user).
test('messages, threads, offers and support tickets: a user lists only rows they take part in, and a client filter cannot widen it', async () => {
  const victim = `victim2-${randomUUID()}@test.local`;
  const viewer = `viewer2-${randomUUID()}@test.local`;
  const other = `other2-${randomUUID()}@test.local`;
  await register(victim);
  await register(other);
  const viewerJwt = await register(viewer);
  const pid = (e: string) => `u_${e.replace(/[^a-z0-9]/g, '_')}`;

  const make = (uid: string, data: Record<string, unknown>) => strapiInstance.entityService.create(uid, { data });
  const ctxOf = (a: string, b: string) => ({
    requesterEmail: a, requesterProfileId: pid(a), receiverEmail: b, receiverProfileId: pid(b),
  });
  const seedAll = async (a: string, b: string, tag: string) => {
    await make('api::message.message', { threadId: `t-${tag}`, message: `private ${tag}`, senderEmail: a, ...ctxOf(a, b) });
    await make('api::thread.thread', { conversationKey: `k-${tag}`, threadId: `t-${tag}`, personName: tag, ...ctxOf(a, b) });
    await make('api::offer.offer', { offerId: `o-${tag}`, ...ctxOf(a, b) });
    await make('api::support-ticket.support-ticket', { ticketNo: `s-${tag}`, ownerEmail: a, ownerProfileId: pid(a) });
  };
  await seedAll(victim, other, 'foreign');
  await seedAll(viewer, other, 'mine');

  const marker = (rows: any[]) => JSON.stringify(rows ?? []);
  for (const url of ['/messages', '/threads', '/offers', '/support-tickets']) {
    for (const qs of ['', '?pagination[pageSize]=100', `?filters[requesterEmail][$eq]=${victim}`, `?filters[ownerEmail][$eq]=${victim}`, `?filters[$or][0][requesterEmail][$eq]=${victim}&filters[$or][1][ownerEmail][$eq]=${victim}`]) {
      const res = await fetch(`${BASE_URL}${url}${qs}`, { headers: { authorization: `Bearer ${viewerJwt}` } });
      // an unknown filter key is a 400, which is fine: nothing is returned
      assert.ok([200, 400].includes(res.status), `${url}${qs}: status ${res.status}`);
      if (res.status !== 200) continue;
      const rows = (await res.json()).data as any[];
      const text = marker(rows);
      assert.equal(text.includes(victim), false, `${url}${qs}: victim data leaked`);
      assert.equal(text.includes('foreign'), false, `${url}${qs}: foreign row leaked`);
      if (qs === '') assert.ok(text.includes('mine'), `${url}: own row missing`);
    }
  }
});

// A non-owner reading another user's thread / support ticket by id is denied.
// It used to answer 500 (measured in production) instead of 403.
test('a non-owner reading someone else\'s thread or support ticket by id gets 403, never 500 or the data', async () => {
  const owner = `owner3-${randomUUID()}@test.local`;
  const stranger = `stranger3-${randomUUID()}@test.local`;
  await register(owner);
  const strangerJwt = await register(stranger);
  const pid = `u_${owner.replace(/[^a-z0-9]/g, '_')}`;
  const thread = await strapiInstance.entityService.create('api::thread.thread', {
    data: { conversationKey: `k-${randomUUID()}`, threadId: `t-${randomUUID()}`, requesterEmail: owner, requesterProfileId: pid, receiverEmail: 'x@test.local', receiverProfileId: 'u_x' },
  });
  const ticket = await strapiInstance.entityService.create('api::support-ticket.support-ticket', {
    data: { ticketNo: `s-${randomUUID()}`, subject: 'secret subject', ownerEmail: owner, ownerProfileId: pid },
  });
  for (const [url, doc] of [['/threads', thread.documentId], ['/support-tickets', ticket.documentId]] as const) {
    const res = await fetch(`${BASE_URL}${url}/${doc}`, { headers: { authorization: `Bearer ${strangerJwt}` } });
    const text = await res.text();
    assert.equal(res.status, 403, `${url}/:id as non-owner -> ${res.status} ${text.slice(0, 200)}`);
    assert.equal(text.includes('secret subject') || text.includes(owner), false, `${url}/:id leaked data`);
  }
});
