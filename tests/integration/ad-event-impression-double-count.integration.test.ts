/**
 * SEMANTIC_CONTRACT_S2 (audit finding 2.7) — POST /ad-events used to bump
 * `impressions` unconditionally on every event, regardless of eventType,
 * while Engagement v1's registerView (VIEW_COUNT_FIELD.ad='impressions',
 * 24h actor-dedup) already atomically owns that exact same field. The
 * only eventType any live Flutter caller sends here is 'click'
 * (ApprovedAdsStore.trackClick) -- meaning opening an ad detail page
 * double-counted one real view as two impressions, and a click was
 * ALSO counted as an impression. This suite proves: a 'click' event no
 * longer touches `impressions` (or any impression-labeled counter); a
 * genuine 'impression' event still bumps the legacy show/display/view
 * counters (but never `impressions`, which stays Engagement v1's alone);
 * and the real end-to-end scenario (registerView + trackClick, same as
 * main.dart's ad detail page initState) increments `impressions` exactly
 * once, not twice.
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

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-ad-event-impression-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-ad-event-impression-test.db');
const PORT = 14163;
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

async function createAd(overrides: Record<string, unknown> = {}) {
  return strapiInstance.entityService.create('api::ad.ad', {
    data: {
      title: 'Test Reklam',
      impressions: 0,
      likes: 0,
      showCount: 0,
      displayCount: 0,
      viewCount: 0,
      ...overrides,
    },
  });
}

const fetchAd = async (id: number | string) =>
  strapiInstance.db.query('api::ad.ad').findOne({ where: { id } } as any);

test('a click event does not touch impressions or any impression-labeled counter', async () => {
  const ad = await createAd();
  const res = await fetch(`${BASE_URL}/ad-events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: { adId: String(ad.id), eventType: 'click' } }),
  });
  assert.equal(res.status, 200);
  const row = await fetchAd(ad.id);
  assert.equal(row.impressions, 0, 'a click must never increment impressions -- that is engagement-v1-only');
  assert.equal(row.showCount, 0);
  assert.equal(row.displayCount, 0);
  assert.equal(row.viewCount, 0);
});

test('a genuine impression event still bumps the legacy show/display/view counters, but never impressions', async () => {
  const ad = await createAd();
  const res = await fetch(`${BASE_URL}/ad-events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: { adId: String(ad.id), eventType: 'impression' } }),
  });
  assert.equal(res.status, 200);
  const row = await fetchAd(ad.id);
  assert.equal(row.impressions, 0, 'impressions stays Engagement v1-only even for a genuine impression event');
  assert.equal(row.showCount, 1);
  assert.equal(row.displayCount, 1);
  assert.equal(row.viewCount, 1);
});

test('real end-to-end scenario: registerView + trackClick (main.dart ad detail page) increments impressions exactly once', async () => {
  const ad = await createAd();
  const jwt = await registerAndLogin(`ad-view-${randomUUID()}@test.local`);

  // Mirrors main.dart's ad detail page initState: registerView (Engagement
  // v1, the real impression) fired alongside trackClick (POST /ad-events,
  // eventType:'click', deliberately outside the engagement contract).
  const viewRes = await fetch(`${BASE_URL}/engagements/view`, {
    method: 'POST',
    headers: authed(jwt),
    body: JSON.stringify({ targetType: 'ad', targetId: ad.id }),
  });
  assert.equal(viewRes.status, 200);

  const clickRes = await fetch(`${BASE_URL}/ad-events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ data: { adId: String(ad.id), eventType: 'click' } }),
  });
  assert.equal(clickRes.status, 200);

  const row = await fetchAd(ad.id);
  assert.equal(row.impressions, 1, 'one real ad-detail-page open must count as exactly one impression, not two');
});
