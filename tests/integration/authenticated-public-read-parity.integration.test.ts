/**
 * Full-app reconciliation P1 (measured in production): the Authenticated role
 * does NOT inherit the Public role in Strapi, and the bootstrap only granted
 * the Knowledge Hub category/banner and agri-data reads (hub-category,
 * hub-banner, agri-product, province, agri-price-observation,
 * agri-weather-cache find/findOne) to Public. Flutter sends the JWT on those
 * reads whenever a user is logged in, so every logged-in user got 403 on the
 * Knowledge Hub taxonomy and every Tarimsal Veriler screen while a logged-out
 * visitor could read them. Invariant: whatever a visitor can read, a signed-in
 * user can read.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-auth-read-parity-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-auth-read-parity-test.db');
const PORT = 14263;
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

const get = async (url: string, jwt?: string) => {
  const res = await fetch(`${BASE_URL}${url}`, {
    headers: jwt ? { authorization: `Bearer ${jwt}` } : {},
  });
  return res.status;
};

const PUBLIC_READ_COLLECTIONS = [
  '/listings',
  '/ads',
  '/hub-contents',
  '/hub-categories',
  '/hub-banners',
  '/agri-products',
  '/provinces',
  '/agri-price-observations',
  '/agri-weather-caches',
  '/logistics-loads',
  '/logistics-vehicles',
  '/logistics-offers',
  '/processed-products/public',
  '/processed-seller-stores/public',
  '/market/snapshot',
];

test('every collection a visitor can read is also readable by a signed-in user', async () => {
  const email = `parity-${Date.now()}@test.local`;
  const reg = await fetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  const jwt = (await reg.json()).jwt as string;
  assert.ok(jwt);

  const mismatches: string[] = [];
  for (const url of PUBLIC_READ_COLLECTIONS) {
    const anon = await get(url);
    const authed = await get(url, jwt);
    if (anon === 200 && authed !== 200) mismatches.push(`${url}: visitor ${anon}, signed-in ${authed}`);
    assert.equal(anon, 200, `${url} should be publicly readable (got ${anon})`);
  }
  assert.deepEqual(mismatches, []);
});

const REGRESSED_TYPES = [
  '/hub-categories',
  '/hub-banners',
  '/agri-products',
  '/provinces',
  '/agri-price-observations',
  '/agri-weather-caches',
];

const send = async (method: string, url: string, jwt?: string, body?: unknown) => {
  const res = await fetch(`${BASE_URL}${url}`, {
    method,
    headers: { 'content-type': 'application/json', ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.status;
};

test('the six regressed types: find and findOne behave identically for visitor and signed-in user, and writes stay closed to both', async () => {
  const email = `parity2-${Date.now()}@test.local`;
  const reg = await fetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  const jwt = (await reg.json()).jwt as string;

  for (const url of REGRESSED_TYPES) {
    // find: 200 for both
    assert.equal(await send('GET', url), 200, `anonymous find ${url}`);
    assert.equal(await send('GET', url, jwt), 200, `signed-in find ${url}`);
    // findOne: same verdict for both, and it is "not found", never "forbidden"
    const anonOne = await send('GET', `${url}/nonexistent-document-id`);
    const authOne = await send('GET', `${url}/nonexistent-document-id`, jwt);
    assert.equal(anonOne, 404, `anonymous findOne ${url}`);
    assert.equal(authOne, 404, `signed-in findOne ${url}`);
    // create / update / delete: closed for both
    for (const who of [undefined, jwt]) {
      const label = who ? 'signed-in' : 'anonymous';
      assert.equal(await send('POST', url, who, { data: {} }), 403, `${label} create ${url}`);
      assert.equal(await send('PUT', `${url}/some-id`, who, { data: {} }), 403, `${label} update ${url}`);
      assert.equal(await send('DELETE', `${url}/some-id`, who), 403, `${label} delete ${url}`);
    }
  }
});
