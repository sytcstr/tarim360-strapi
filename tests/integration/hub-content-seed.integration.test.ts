/**
 * Bilgi Bankasi content seed against a REAL Strapi boot on a throwaway SQLite
 * file: off / dry-run / apply, create-only, idempotency, fail-closed on
 * missing category dependency, featured ordering, Ciftciden Sorular
 * untouched, existing editorial edits survive a re-apply.
 *
 * Run: npm run test:integration
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import {
  BANNER_UID,
  CATEGORY_UID,
  CONTENT_UID,
  runHubContentSeed,
} from '../../src/utils/hub-content-seed';
import categoriesData from '../../src/seeds/data/hub-categories.json';
import articlesData from '../../src/seeds/data/hub-articles.json';
import bannersData from '../../src/seeds/data/hub-banners.json';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-hub-content-seed-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-hub-content-seed-test.db');

let strapi: any;

// hub-category / hub-banner are draft-and-publish: a create+publish leaves a
// draft AND a published row, so counts/reads are scoped to published rows
// (hub-content has draftAndPublish=false, no such split).
const categoryCount = () => strapi.db.query(CATEGORY_UID).count({ where: { publishedAt: { $notNull: true } } });
const articleCount = () => strapi.db.query(CONTENT_UID).count({});
const bannerCount = () => strapi.db.query(BANNER_UID).count({ where: { publishedAt: { $notNull: true } } });
const categories = () =>
  strapi.db.query(CATEGORY_UID).findMany({ where: { publishedAt: { $notNull: true } }, limit: 100 });
const articles = () => strapi.db.query(CONTENT_UID).findMany({ where: {}, limit: 200 });

before(async () => {
  if (existsSync(TEST_DB_FILE)) unlinkSync(TEST_DB_FILE);
  process.env.DATABASE_CLIENT = 'sqlite';
  process.env.DATABASE_FILENAME = TEST_DB_FILE_RELATIVE;
  process.env.PORT = '14396';
  const compiled = await compileStrapi();
  strapi = await createStrapi(compiled).load();
});

after(async () => {
  await strapi?.destroy?.();
  if (existsSync(TEST_DB_FILE)) unlinkSync(TEST_DB_FILE);
});

beforeEach(async () => {
  await strapi.db.query(CONTENT_UID).deleteMany({});
  await strapi.db.query(CATEGORY_UID).deleteMany({});
  await strapi.db.query(BANNER_UID).deleteMany({});
});

test('OFF: no mutation', async () => {
  const r = await runHubContentSeed(strapi, { mode: 'off' });
  assert.equal(r.status, 'off');
  assert.equal(await categoryCount(), 0);
  assert.equal(await articleCount(), 0);
  assert.equal(await bannerCount(), 0);
});

test('DRY-RUN: reports 8 categories / 16 articles / 1 banner wouldCreate, zero writes', async () => {
  const r = await runHubContentSeed(strapi, { mode: 'dry-run' });
  assert.equal(r.status, 'dry-run');
  assert.equal(r.category.wouldCreate, 8);
  assert.equal(r.article.wouldCreate, 16);
  assert.equal(r.banner.wouldCreate, 1);
  assert.equal(r.article.missingDependency, 0, 'categories are planned first, so no article is blocked in dry-run');
  assert.equal(await categoryCount(), 0);
  assert.equal(await articleCount(), 0);
  assert.equal(await bannerCount(), 0);
});

test('APPLY on an empty DB creates 8 categories, 16 articles, 1 banner, all published', async () => {
  const r = await runHubContentSeed(strapi, { mode: 'apply' });
  assert.equal(r.status, 'applied', JSON.stringify(r.errors));
  assert.equal(r.category.created, 8);
  assert.equal(r.article.created, 16);
  assert.equal(r.banner.created, 1);
  assert.equal(await categoryCount(), 8);
  assert.equal(await articleCount(), 16);
  assert.equal(await bannerCount(), 1);

  const cats = await categories();
  assert.equal(new Set(cats.map((c: any) => c.slug)).size, 8);
  assert.ok(cats.every((c: any) => c.publishedAt));
  assert.ok(cats.every((c: any) => c.isActive === true));
  assert.ok(cats.every((c: any) => c.contentType === 'knowledge'));

  const rows = await articles();
  assert.equal(new Set(rows.map((a: any) => a.slug)).size, 16);
  assert.ok(rows.every((a: any) => a.kind === 'knowledge'));
  const populated = await strapi.db.query(CONTENT_UID).findMany({ where: {}, populate: ['category'], limit: 200 });
  assert.ok(populated.every((a: any) => a.category != null), 'every article has a category relation');
  const featured = rows.filter((a: any) => a.isFeatured === true);
  assert.equal(featured.length, 4);
  assert.deepEqual(
    featured.map((a: any) => a.featuredOrder).sort((x: number, y: number) => x - y),
    [1, 2, 3, 4],
  );
  assert.ok(rows.every((a: any) => a.readingTimeMinutes >= 1));

  const banner = (await strapi.db.query(BANNER_UID).findMany({ where: { publishedAt: { $notNull: true } } }))[0];
  assert.equal(banner.title, 'Bilgiyle Üret, Geleceği Büyüt');
  assert.equal(banner.contentType, 'knowledge');
  assert.equal(banner.isActive, true);
  assert.ok(banner.publishedAt);
});

test('article -> category relation actually resolves to the seeded category', async () => {
  await runHubContentSeed(strapi, { mode: 'apply' });
  const full = await strapi.documents(CONTENT_UID).findFirst({
    filters: { slug: 'bugdayda-verimi-etkileyen-temel-faktorler' },
    populate: { category: true },
  });
  assert.equal(full.category.slug, 'bitkisel-uretim');
});

test('second APPLY is idempotent: 0 created, counts unchanged', async () => {
  await runHubContentSeed(strapi, { mode: 'apply' });
  const before = { c: await categoryCount(), a: await articleCount(), b: await bannerCount() };
  const r2 = await runHubContentSeed(strapi, { mode: 'apply' });
  assert.equal(r2.status, 'up-to-date');
  assert.equal(r2.category.created, 0);
  assert.equal(r2.article.created, 0);
  assert.equal(r2.banner.created, 0);
  assert.equal(r2.category.existing, 8);
  assert.equal(r2.article.existing, 16);
  assert.equal(r2.banner.existing, 1);
  assert.equal(await categoryCount(), before.c);
  assert.equal(await articleCount(), before.a);
  assert.equal(await bannerCount(), before.b);
});

test('existing editorial edits are never overwritten by a re-apply', async () => {
  await runHubContentSeed(strapi, { mode: 'apply' });
  const cat = (await categories()).find((c: any) => c.slug === 'bitkisel-uretim');
  await strapi.db.query(CATEGORY_UID).update({ where: { id: cat.id }, data: { name: 'Editör Değişikliği', sortOrder: 99 } });
  const art = (await articles()).find((a: any) => a.slug === 'bugdayda-verimi-etkileyen-temel-faktorler');
  await strapi.db.query(CONTENT_UID).update({ where: { id: art.id }, data: { title: 'Editör Başlığı', isFeatured: false } });

  await runHubContentSeed(strapi, { mode: 'apply' });

  const catAfter = (await categories()).find((c: any) => c.slug === 'bitkisel-uretim');
  assert.equal(catAfter.name, 'Editör Değişikliği');
  assert.equal(catAfter.sortOrder, 99);
  const artAfter = (await articles()).find((a: any) => a.slug === 'bugdayda-verimi-etkileyen-temel-faktorler');
  assert.equal(artAfter.title, 'Editör Başlığı');
  assert.equal(artAfter.isFeatured, false);
});

test('a pre-existing category with the same slug is reused, never duplicated or overwritten, and its articles still attach', async () => {
  await strapi.documents(CATEGORY_UID).create({
    data: { name: 'Çakışan', slug: 'bitkisel-uretim', contentType: 'knowledge', isActive: false, sortOrder: 0 } as any,
    status: 'published',
  } as any);
  const r = await runHubContentSeed(strapi, { mode: 'apply' });
  assert.equal(r.category.created, 7, 'the other 7 categories are unaffected by the pre-existing one');
  assert.equal(r.article.created, 16, 'the pre-existing category is reused, articles still attach to it');
  const cat = (await categories()).find((c: any) => c.slug === 'bitkisel-uretim');
  assert.equal(cat.name, 'Çakışan', 'the pre-existing category row itself is never overwritten');
});

test('user data (Çiftçiden Sorular / farmerQuestion rows) is untouched', async () => {
  const farmerQ = await strapi.documents(CONTENT_UID).create({
    data: { kind: 'farmerQuestion', title: 'Bir çiftçi sorusu', ownerEmail: 'user@example.invalid' } as any,
  } as any);
  await runHubContentSeed(strapi, { mode: 'dry-run' });
  await runHubContentSeed(strapi, { mode: 'apply' });
  await runHubContentSeed(strapi, { mode: 'apply' });
  const rows = await articles();
  const stillThere = rows.find((r: any) => r.documentId === farmerQ.documentId);
  assert.ok(stillThere);
  assert.equal(stillThere.kind, 'farmerQuestion');
  assert.equal(stillThere.title, 'Bir çiftçi sorusu');
  assert.equal(rows.filter((r: any) => r.kind === 'farmerQuestion').length, 1);
});

test('source data: exactly 8 categories / 16 articles (2 per category) / 4 featured 1..4, no duplicate slugs', () => {
  assert.equal(categoriesData.length, 8);
  assert.equal(new Set((categoriesData as any[]).map((c) => c.slug)).size, 8);
  assert.equal(articlesData.length, 16);
  assert.equal(new Set((articlesData as any[]).map((a) => a.slug)).size, 16);
  const perCategory: Record<string, number> = {};
  for (const a of articlesData as any[]) perCategory[a.categorySlug] = (perCategory[a.categorySlug] || 0) + 1;
  for (const c of categoriesData as any[]) assert.equal(perCategory[c.slug], 2, c.slug);
  const featured = (articlesData as any[]).filter((a) => a.isFeatured);
  assert.equal(featured.length, 4);
  assert.deepEqual(featured.map((a) => a.featuredOrder).sort(), [1, 2, 3, 4]);
  assert.equal(bannersData.length, 1);
});
