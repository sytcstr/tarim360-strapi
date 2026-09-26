/**
 * Reference seed engine against a REAL Strapi boot on a throwaway SQLite file:
 * off / dry-run / apply, create-only, idempotency, fail-closed conflicts,
 * version marker rules, integrity repair and user-data safety.
 *
 * Run: npm run test:integration
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import {
  PRODUCT_UID,
  PROVINCE_UID,
  REFERENCE_SEED_VERSION,
  runReferenceSeed,
} from '../../src/utils/reference-seed';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-reference-seed-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-reference-seed-test.db');
const HUB_UID = 'api::hub-content.hub-content';

let strapi: any;

const rows = (uid: string, where: any = {}) => strapi.db.query(uid).findMany({ where, limit: 1000 });
const publishedCount = (uid: string) => strapi.db.query(uid).count({ where: { publishedAt: { $notNull: true } } });
const totalCount = (uid: string) => strapi.db.query(uid).count({});
const storedVersion = async () =>
  (await strapi.store({ type: 'core', name: 'reference_seed' }).get({ key: 'reference_seed_version' }))?.version ?? null;

before(async () => {
  if (existsSync(TEST_DB_FILE)) unlinkSync(TEST_DB_FILE);
  process.env.DATABASE_CLIENT = 'sqlite';
  process.env.DATABASE_FILENAME = TEST_DB_FILE_RELATIVE;
  process.env.PORT = '14299';
  const compiled = await compileStrapi();
  strapi = await createStrapi(compiled).load();
});

after(async () => {
  await strapi?.destroy?.();
  if (existsSync(TEST_DB_FILE)) unlinkSync(TEST_DB_FILE);
});

beforeEach(async () => {
  await strapi.db.query(PROVINCE_UID).deleteMany({});
  await strapi.db.query(PRODUCT_UID).deleteMany({});
  await strapi.store({ type: 'core', name: 'reference_seed' }).delete({ key: 'reference_seed_version' });
});

test('OFF: no mutation and no version', async () => {
  const r = await runReferenceSeed(strapi, { mode: 'off' });
  assert.equal(r.status, 'off');
  assert.equal(await totalCount(PROVINCE_UID), 0);
  assert.equal(await totalCount(PRODUCT_UID), 0);
  assert.equal(await storedVersion(), null);
});

test('DRY-RUN: reports wouldCreate 81/52 and mutates nothing (no version)', async () => {
  const r = await runReferenceSeed(strapi, { mode: 'dry-run' });
  assert.equal(r.status, 'dry-run');
  assert.equal(r.province.wouldCreate, 81);
  assert.equal(r.product.wouldCreate, 52);
  assert.equal(r.province.existing, 0);
  assert.equal(r.province.conflicts + r.product.conflicts, 0);
  assert.equal(await totalCount(PROVINCE_UID), 0);
  assert.equal(await totalCount(PRODUCT_UID), 0);
  assert.equal(await storedVersion(), null);
  assert.equal(r.versionWritten, false);
});

test('APPLY on an empty DB creates and PUBLISHES 81 provinces + 52 products, then writes the version', async () => {
  const r = await runReferenceSeed(strapi, { mode: 'apply' });
  assert.equal(r.status, 'applied', JSON.stringify(r.errors));
  assert.equal(r.province.created, 81);
  assert.equal(r.product.created, 52);
  assert.equal(await publishedCount(PROVINCE_UID), 81);
  assert.equal(await publishedCount(PRODUCT_UID), 52);
  assert.equal(await storedVersion(), REFERENCE_SEED_VERSION);
  assert.equal(r.versionWritten, true);
  const konya = (await rows(PROVINCE_UID, { slug: 'konya', publishedAt: { $notNull: true } }))[0];
  assert.equal(konya.plateCode, '42');
  assert.equal(konya.regionName, 'İç Anadolu');
  const wheat = (await rows(PRODUCT_UID, { slug: 'bugday', publishedAt: { $notNull: true } }))[0];
  assert.equal(wheat.categoryName, 'Hububat');
  assert.equal(wheat.defaultUnit, 'kg');
  // reference rows carry no price-like data
  assert.equal('price' in wheat, false);
});

test('second APPLY is idempotent: 0 created, no duplicates', async () => {
  await runReferenceSeed(strapi, { mode: 'apply' });
  const before = await totalCount(PROVINCE_UID);
  const r = await runReferenceSeed(strapi, { mode: 'apply' });
  assert.equal(r.status, 'up-to-date');
  assert.equal(r.province.created + r.product.created, 0);
  assert.equal(r.province.existing, 81);
  assert.equal(r.product.existing, 52);
  assert.equal(await totalCount(PROVINCE_UID), before);
  assert.equal(await publishedCount(PROVINCE_UID), 81);
  assert.equal(await publishedCount(PRODUCT_UID), 52);
});

test('existing rows are never overwritten (admin edits survive a re-apply)', async () => {
  await runReferenceSeed(strapi, { mode: 'apply' });
  const wheat = (await rows(PRODUCT_UID, { slug: 'bugday' }));
  for (const row of wheat) {
    await strapi.db.query(PRODUCT_UID).update({
      where: { id: row.id },
      data: { name: 'Buğday (admin)', isActive: false, categoryName: 'Sebze' },
    });
  }
  await runReferenceSeed(strapi, { mode: 'apply' });
  const after = await rows(PRODUCT_UID, { slug: 'bugday' });
  for (const row of after) {
    assert.equal(row.name, 'Buğday (admin)');
    assert.equal(row.isActive, false);
    assert.equal(row.categoryName, 'Sebze');
  }
});

test('CONFLICT fails closed: nothing is created, no version', async () => {
  // plate 34 already belongs to a different slug -> inconsistent identity
  await strapi.documents(PROVINCE_UID).create({
    data: { name: 'Baska', slug: 'baska-il', plateCode: '34', isActive: true },
    status: 'published',
  });
  const r = await runReferenceSeed(strapi, { mode: 'apply' });
  assert.equal(r.status, 'conflict');
  assert.ok(r.conflictKeys.some((k) => k.startsWith('province:istanbul/34')));
  assert.equal(r.province.created + r.product.created, 0);
  assert.equal(await publishedCount(PROVINCE_UID), 1, 'only the pre-existing row');
  assert.equal(await totalCount(PRODUCT_UID), 0);
  assert.equal(await storedVersion(), null);
  // dry-run reports the same conflict, still read-only
  const d = await runReferenceSeed(strapi, { mode: 'dry-run' });
  assert.equal(d.status, 'conflict');
  assert.equal(await publishedCount(PROVINCE_UID), 1);
});

test('product slug pointing at a different code is a conflict', async () => {
  await strapi.documents(PRODUCT_UID).create({
    data: { name: 'Buğday', slug: 'bugday', code: 'BASKA_KOD', isActive: true },
    status: 'published',
  });
  const r = await runReferenceSeed(strapi, { mode: 'apply' });
  assert.equal(r.status, 'conflict');
  assert.equal(await totalCount(PROVINCE_UID), 0);
});

test('version is written only after a FULLY successful apply; a partial failure is resumable', async () => {
  const partial = await runReferenceSeed(strapi, { mode: 'apply', failAfterCreates: 10 });
  assert.equal(partial.status, 'failed');
  assert.equal(partial.versionWritten, false);
  assert.equal(await storedVersion(), null);
  assert.equal(await publishedCount(PROVINCE_UID), 10);
  const resumed = await runReferenceSeed(strapi, { mode: 'apply' });
  assert.equal(resumed.status, 'applied');
  assert.equal(resumed.province.created, 71);
  assert.equal(resumed.product.created, 52);
  assert.equal(await publishedCount(PROVINCE_UID), 81);
  assert.equal(await storedVersion(), REFERENCE_SEED_VERSION);
});

test('a stored version never hides a missing record (integrity repair)', async () => {
  await runReferenceSeed(strapi, { mode: 'apply' });
  assert.equal(await storedVersion(), REFERENCE_SEED_VERSION);
  await strapi.db.query(PRODUCT_UID).deleteMany({ where: { slug: 'arpa' } });
  const dry = await runReferenceSeed(strapi, { mode: 'dry-run' });
  assert.equal(dry.product.wouldCreate, 1, 'dry-run sees the gap despite the version marker');
  const r = await runReferenceSeed(strapi, { mode: 'apply' });
  assert.equal(r.product.created, 1);
  assert.equal(await publishedCount(PRODUCT_UID), 52);
});

test('user data is untouched by dry-run and apply', async () => {
  const hub = await strapi.documents(HUB_UID).create({
    data: { kind: 'knowledge', title: 'Kullanici icerigi', ownerEmail: 'user@example.invalid' },
  });
  const beforeRows = await rows(HUB_UID);
  await runReferenceSeed(strapi, { mode: 'dry-run' });
  await runReferenceSeed(strapi, { mode: 'apply' });
  await runReferenceSeed(strapi, { mode: 'apply' });
  const afterRows = await rows(HUB_UID);
  assert.equal(afterRows.length, beforeRows.length);
  assert.equal(afterRows[0].title, 'Kullanici icerigi');
  assert.equal(afterRows[0].documentId, hub.documentId);
  assert.equal(await totalCount('api::agri-price-observation.agri-price-observation'), 0, 'no price rows are ever created');
  assert.equal(await totalCount('api::hub-category.hub-category'), 0, 'hub categories are not seeded');
  assert.equal(await totalCount('api::hub-banner.hub-banner'), 0, 'hub banners are not seeded');
});
