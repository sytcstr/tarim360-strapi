/**
 * SEMANTIC_CONTRACT_S2 (audit finding 2.11) — ad.ts had NO field guard at
 * all (stock factories.createCoreController). The ad-owner-write policy
 * only checks ownership, never sanitizes the payload, so any authenticated
 * user who owns an ad could PATCH approvalStatus/isApproved/reviewStatus/
 * approved on their own ad via a normal PUT /ads/:id -- and
 * approved_ads_repo.dart's own _isApproved() gate reads exactly those
 * fields to decide whether an ad is shown in the public Approved Ads feed.
 * This suite proves: a normal owner cannot self-approve their own ad
 * (create-time and update-time spoofing of every approval/moderation
 * field is stripped), the same engagement/analytics counters S2.2 made
 * server-exclusive cannot be spoofed here either, normal user-editable
 * fields keep working exactly as before, and a legitimate admin/moderator
 * update (which goes through Strapi's own admin-panel-privileged surface,
 * not this public-REST field guard) still works.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-ad-moderation-guard-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-ad-moderation-guard-test.db');
const PORT = 14164;
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

async function createAd(jwt: string, overrides: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE_URL}/ads`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({
      data: {
        title: 'Field Guard Test Reklami',
        description: 'test',
        ...overrides,
      },
    }),
  });
  return res.json();
}

const fetchRow = async (id: number | string) =>
  strapiInstance.db.query('api::ad.ad').findOne({ where: { id } } as any);

const fetchRowByDocumentId = async (documentId: string) =>
  strapiInstance.db.query('api::ad.ad').findOne({ where: { documentId } } as any);

test('create: spoofed approval/moderation/engagement fields are ignored, server defaults apply', async () => {
  const jwt = await registerAndLogin(`ad-create-spoof-${randomUUID()}@test.local`);
  const body = await createAd(jwt, {
    approvalStatus: 'approved',
    reviewStatus: 'approved',
    isApproved: true,
    approved: true,
    likes: 999,
    impressions: 999,
    likeCount: 999,
    favoriteCount: 999,
    showCount: 999,
    displayCount: 999,
    viewCount: 999,
    videoViews: 999,
    izlenmeCount: 999,
    engagementVersion: 999,
    isPremiumOwner: true,
  });
  assert.notEqual(body.data.approvalStatus, 'approved');
  assert.notEqual(body.data.reviewStatus, 'approved');
  assert.notEqual(body.data.isApproved, true);
  assert.notEqual(body.data.approved, true);
  assert.notEqual(body.data.likes, 999);
  assert.notEqual(body.data.impressions, 999);
  assert.notEqual(body.data.likeCount, 999);
  assert.notEqual(body.data.favoriteCount, 999);
  assert.notEqual(body.data.viewCount, 999);
  assert.notEqual(body.data.isPremiumOwner, true);
});

test('update: a normal owner cannot self-approve their own ad (approvalStatus/isApproved/reviewStatus/approved all stripped)', async () => {
  const jwt = await registerAndLogin(`ad-update-spoof-${randomUUID()}@test.local`);
  const created = await createAd(jwt);

  const res = await fetch(`${BASE_URL}/ads/${created.data.documentId}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({
      data: {
        approvalStatus: 'approved',
        reviewStatus: 'approved',
        isApproved: true,
        approved: true,
      },
    }),
  });
  assert.equal(res.status, 200, 'the real owner must still be able to update their own ad');

  const row = await fetchRowByDocumentId(created.data.documentId);
  assert.notEqual(row.approvalStatus, 'approved', 'a normal owner must not be able to self-approve via approvalStatus');
  assert.notEqual(row.reviewStatus, 'approved', 'a normal owner must not be able to self-approve via reviewStatus');
  assert.notEqual(row.isApproved, true, 'a normal owner must not be able to self-approve via isApproved');
  assert.notEqual(row.approved, true, 'a normal owner must not be able to self-approve via approved');
});

test('update: the same engagement/analytics counters S2.2 made server-exclusive cannot be spoofed here either', async () => {
  const jwt = await registerAndLogin(`ad-update-engagement-spoof-${randomUUID()}@test.local`);
  const created = await createAd(jwt);

  const res = await fetch(`${BASE_URL}/ads/${created.data.documentId}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({
      data: {
        likes: 99999,
        impressions: 99999,
        likeCount: 99999,
        favoriteCount: 99999,
        showCount: 99999,
        displayCount: 99999,
        viewCount: 99999,
        videoViews: 99999,
        izlenmeCount: 99999,
        engagementVersion: 99999,
        isPremiumOwner: true,
      },
    }),
  });
  assert.equal(res.status, 200);

  const row = await fetchRowByDocumentId(created.data.documentId);
  assert.notEqual(row.impressions, 99999, 'impressions stays Engagement v1-only, per S2.2');
  assert.notEqual(row.likes, 99999);
  assert.notEqual(row.likeCount, 99999);
  assert.notEqual(row.favoriteCount, 99999);
  assert.notEqual(row.viewCount, 99999);
  assert.notEqual(row.isPremiumOwner, true, 'isPremiumOwner is premium-sync.ts-owned, same as listing.ts');
});

test('update: normal, user-editable fields still work exactly as before', async () => {
  const jwt = await registerAndLogin(`ad-update-normal-${randomUUID()}@test.local`);
  const created = await createAd(jwt);

  const res = await fetch(`${BASE_URL}/ads/${created.data.documentId}`, {
    method: 'PUT',
    headers: authed(jwt),
    body: JSON.stringify({
      data: {
        title: 'Guncellenmis Reklam Basligi',
        description: 'Guncellenmis aciklama',
      },
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.title, 'Guncellenmis Reklam Basligi');
  assert.equal(body.data.description, 'Guncellenmis aciklama');
});

test('a legitimate admin/moderator approval (via entityService, the same surface Strapi\'s admin panel uses) still works — this fix only guards the public REST field surface', async () => {
  const jwt = await registerAndLogin(`ad-admin-approve-${randomUUID()}@test.local`);
  const created = await createAd(jwt);

  await strapiInstance.entityService.update('api::ad.ad' as any, created.data.id, {
    data: { approvalStatus: 'approved', isApproved: true },
  });

  const row = await fetchRow(created.data.id);
  assert.equal(row.approvalStatus, 'approved');
  assert.equal(row.isApproved, true);
});
