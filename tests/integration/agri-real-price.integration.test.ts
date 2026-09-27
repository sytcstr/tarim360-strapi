/**
 * Real (TOBB) price ingestion against a REAL Strapi boot on a throwaway SQLite
 * file, with the HTTP layer replaced by saved TOBB pages: mode gate, dry-run =
 * zero writes, apply = valid-only writes, dedupe/idempotency, reference safety,
 * existing observations never deleted, unique dedupeKey.
 *
 * Run: npm run test:integration
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { runReferenceSeed } from '../../src/utils/reference-seed';
import { runRealPriceIngestion, OBSERVATION_UID } from '../../src/services/agri-real-price/runner';
import { createTobbFetcher, type HttpGet } from '../../src/services/agri-real-price/tobb/fetcher';
import { startRealPriceIngestionIfEnabled } from '../../src/services/agri-real-price';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-agri-real-price-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-agri-real-price-test.db');
const FIX = path.join(__dirname, '..', 'fixtures', 'tobb');
const NOW = new Date('2026-09-26T12:00:00Z');
const PRODUCT_UID = 'api::agri-product.agri-product';
const HUB_UID = 'api::hub-content.hub-content';

const fx = (name: string) => readFileSync(path.join(FIX, name), 'utf8');
const html = (status: number, body = '') => Promise.resolve({ status, contentType: 'text/html; charset=UTF-8', body });

let calls = 0;
const serve: HttpGet = (url) => {
  calls += 1;
  if (url.includes('ana_kod=3&alt_kod=704')) return html(200, fx('nohut_3_704.html'));
  if (url.includes('ana_kod=1&alt_kod=301')) return html(200, fx('cavdar_1_301.html'));
  return html(200, fx('celtik_no_data_1_403.html'));
};
const fetcher = (httpGet: HttpGet = serve) => createTobbFetcher({ httpGet, sleep: async () => {}, delayMs: 0, retries: 0 });

let strapi: any;
const observations = () => strapi.db.query(OBSERVATION_UID).findMany({ where: {}, limit: 1000 });
const count = () => strapi.db.query(OBSERVATION_UID).count({});

before(async () => {
  if (existsSync(TEST_DB_FILE)) unlinkSync(TEST_DB_FILE);
  process.env.DATABASE_CLIENT = 'sqlite';
  process.env.DATABASE_FILENAME = TEST_DB_FILE_RELATIVE;
  process.env.PORT = '14298';
  const compiled = await compileStrapi();
  strapi = await createStrapi(compiled).load();
  const seeded = await runReferenceSeed(strapi, { mode: 'apply' });
  assert.equal(seeded.status, 'applied', JSON.stringify(seeded.errors));
});

after(async () => {
  await strapi?.destroy?.();
  if (existsSync(TEST_DB_FILE)) unlinkSync(TEST_DB_FILE);
});

beforeEach(async () => {
  await strapi.db.query(OBSERVATION_UID).deleteMany({});
  calls = 0;
});

test('OFF: no network and no observation', async () => {
  const r = await runRealPriceIngestion(strapi, { mode: 'off', fetcher: fetcher(), now: NOW });
  assert.equal(r.status, 'off');
  assert.equal(calls, 0);
  assert.equal(await count(), 0);
});

test('DRY-RUN: fetches + parses, reads the DB, writes NOTHING', async () => {
  const r = await runRealPriceIngestion(strapi, { mode: 'dry-run', fetcher: fetcher(), now: NOW });
  assert.equal(r.status, 'dry-run');
  assert.ok(calls >= 9);
  assert.ok(r.wouldCreate >= 3, JSON.stringify(r));
  assert.equal(r.created, 0);
  assert.equal(await count(), 0);
});

test('APPLY writes only the valid observations with full attribution', async () => {
  const r = await runRealPriceIngestion(strapi, { mode: 'apply', fetcher: fetcher(), now: NOW });
  assert.equal(r.status, 'applied', JSON.stringify(r.errors));
  assert.equal(r.errors.length, 0);
  assert.equal(r.created, r.wouldCreate);
  const rows = await observations();
  const published = rows.filter((x: any) => x.publishedAt);
  assert.equal(published.length, r.created, 'every created observation is published');

  const corum = published.find((x: any) => x.marketName === 'Çorum Ticaret Borsası' && Number(x.averagePrice) === 36.83);
  assert.ok(corum, 'Çorum nohut 36,830 TL/kg is stored');
  assert.equal(Number(corum.price), 36.83);
  assert.equal(Number(corum.minPrice), 35.15);
  assert.equal(Number(corum.maxPrice), 38.5);
  assert.equal(corum.unit, 'kg');
  assert.equal(corum.currency, 'TRY');
  assert.equal(Number(corum.quantity), 16000);
  assert.equal(corum.transactionCount, 2);
  assert.equal(corum.provider, 'tobb');
  assert.equal(corum.sourceName, 'Çorum Ticaret Borsası (TOBB)');
  assert.ok(corum.sourceUrl.startsWith('https://borsa.tobb.org.tr/'));
  assert.equal(new Date(corum.observedAt).toISOString(), '2026-09-25T09:31:00.000Z');
  assert.equal(new Date(corum.fetchedAt).toISOString(), NOW.toISOString());
  assert.equal(corum.dataOrigin, 'automated');
  assert.equal(corum.dedupeKey, 'tobb:3-704:CORUM:2026-09-25T09:31:00.000Z:kg');

  // corrupt / stale rows never reach the database
  assert.equal(published.some((x: any) => x.marketName.startsWith('Alaca')), false, 'April row is too old');
  assert.equal(published.some((x: any) => Number(x.averagePrice) > 1000), false, 'TL/ton-as-TL/kg row rejected');

  // relations resolve to the reference rows
  const full = await strapi.documents(OBSERVATION_UID).findFirst({
    filters: { dedupeKey: corum.dedupeKey },
    populate: { product: true, province: true },
    status: 'published',
  });
  assert.equal(full.product.slug, 'nohut');
  assert.equal(full.province.slug, 'corum');
  assert.equal(full.province.plateCode, '19');
});

test('second APPLY is idempotent: 0 created, everything is a duplicate', async () => {
  const first = await runRealPriceIngestion(strapi, { mode: 'apply', fetcher: fetcher(), now: NOW });
  const total = await count();
  const second = await runRealPriceIngestion(strapi, { mode: 'apply', fetcher: fetcher(), now: NOW });
  assert.equal(second.created, 0);
  assert.equal(second.duplicates, first.created);
  assert.equal(await count(), total);
});

test('dedupeKey is UNIQUE through the document service (race safety); runs are serialised', async () => {
  // A draft-and-publish type keeps a draft AND a published row per document, so a
  // raw DB unique index cannot exist; Strapi enforces `unique` in the document
  // service, which is the path the persister uses.
  await runRealPriceIngestion(strapi, { mode: 'apply', fetcher: fetcher(), now: NOW });
  const row = (await observations())[0];
  await assert.rejects(() =>
    strapi.documents(OBSERVATION_UID).create({
      data: { dedupeKey: row.dedupeKey, averagePrice: 1, price: 1 },
      status: 'published',
    }),
  );
  // two overlapping runs share one execution and cannot double-insert
  const [x, y] = await Promise.all([
    runRealPriceIngestion(strapi, { mode: 'apply', fetcher: fetcher(), now: NOW }),
    runRealPriceIngestion(strapi, { mode: 'apply', fetcher: fetcher(), now: NOW }),
  ]);
  assert.equal(x, y);
  const keys = (await observations()).filter((r: any) => r.publishedAt).map((r: any) => r.dedupeKey);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate published observation');
});

test('provider outage: existing observations are untouched, nothing is invented', async () => {
  await runRealPriceIngestion(strapi, { mode: 'apply', fetcher: fetcher(), now: NOW });
  const before = await observations();
  const down = await runRealPriceIngestion(strapi, {
    mode: 'apply',
    fetcher: fetcher(() => html(503)),
    now: NOW,
  });
  assert.equal(down.status, 'provider-failed');
  assert.equal(down.created, 0);
  assert.equal((await observations()).length, before.length);
});

test('missing reference rows: the observation is skipped, no product/province is invented', async () => {
  await strapi.db.query(PRODUCT_UID).deleteMany({ where: { slug: 'nohut' } });
  const r = await runRealPriceIngestion(strapi, { mode: 'apply', fetcher: fetcher(), now: NOW });
  assert.ok(r.referenceMissing >= 1);
  assert.equal(await strapi.db.query(PRODUCT_UID).count({ where: { slug: 'nohut' } }), 0, 'not re-created');
  const rows = await observations();
  assert.equal(rows.some((x: any) => x.dedupeKey.startsWith('tobb:3-704')), false);
  // restore for the remaining tests
  await runReferenceSeed(strapi, { mode: 'apply' });
});

test('user data and hub content are untouched', async () => {
  const hub = await strapi.documents(HUB_UID).create({
    data: { kind: 'knowledge', title: 'Kullanici icerigi', ownerEmail: 'user@example.invalid' },
  });
  await runRealPriceIngestion(strapi, { mode: 'dry-run', fetcher: fetcher(), now: NOW });
  await runRealPriceIngestion(strapi, { mode: 'apply', fetcher: fetcher(), now: NOW });
  const rows = await strapi.db.query(HUB_UID).findMany({ where: {} });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].documentId, hub.documentId);
  assert.equal(rows[0].title, 'Kullanici icerigi');
});

// ── BOOT WIRING (production report: dry-run produced no log at all) ─────────
//
// Root cause: startRealPriceIngestionIfEnabled required BOTH mode != 'off' AND
// an undocumented AGRI_REAL_PRICE_RUN_ON_BOOT=true flag before scheduling
// anything -- unlike its sibling runReferenceSeedIfEnabled, which runs on
// every boot from the mode alone. Setting only
// AGRI_REAL_PRICE_INGESTION_MODE=dry-run (exactly what production had)
// therefore scheduled nothing at all; the summary log only existed on the
// (twice-daily) cron path. These tests drive the exact boot entry point,
// against the real Strapi instance, with the mode env read fresh each time.
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const withMode = async (
  mode: string,
  runOnBoot: string | undefined,
  fn: (logs: string[], bootStrapi: any) => Promise<void>,
) => {
  const prevMode = process.env.AGRI_REAL_PRICE_INGESTION_MODE;
  const prevBoot = process.env.AGRI_REAL_PRICE_RUN_ON_BOOT;
  const prevEnv = process.env.NODE_ENV;
  process.env.AGRI_REAL_PRICE_INGESTION_MODE = mode;
  process.env.NODE_ENV = 'production'; // exactly the reported production scenario
  if (runOnBoot === undefined) delete process.env.AGRI_REAL_PRICE_RUN_ON_BOOT;
  else process.env.AGRI_REAL_PRICE_RUN_ON_BOOT = runOnBoot;
  const logs: string[] = [];
  const bootStrapi = new Proxy(strapi, {
    get(target, prop, receiver) {
      if (prop === 'log') {
        return { info: (m: string) => logs.push(m), error: (m: string) => logs.push('ERROR: ' + m) };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  try {
    await fn(logs, bootStrapi);
  } finally {
    if (prevMode === undefined) delete process.env.AGRI_REAL_PRICE_INGESTION_MODE;
    else process.env.AGRI_REAL_PRICE_INGESTION_MODE = prevMode;
    if (prevBoot === undefined) delete process.env.AGRI_REAL_PRICE_RUN_ON_BOOT;
    else process.env.AGRI_REAL_PRICE_RUN_ON_BOOT = prevBoot;
    if (prevEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevEnv;
  }
};

test('BOOT WIRING production+off: nothing is scheduled (no log, no network, no write)', async () => {
  await withMode('off', undefined, async (logs) => {
    startRealPriceIngestionIfEnabled(strapi, { delayMs: 5, fetcher: fetcher() });
    await sleep(80);
    assert.equal(logs.length, 0);
    assert.equal(calls, 0);
    assert.equal(await count(), 0);
  });
});

test('BOOT WIRING production+dry-run, NO run-on-boot flag (the exact reported scenario): '
  + 'still fetches TOBB and logs a summary; zero writes', async () => {
  await withMode('dry-run', undefined, async (logs, bootStrapi) => {
    const before = await count();
    startRealPriceIngestionIfEnabled(bootStrapi, { delayMs: 5, fetcher: fetcher() });
    await sleep(400);
    assert.ok(calls >= 9, 'TOBB pages were fetched');
    assert.equal(await count(), before, 'dry-run never writes');
    const summary = logs.find((l) => l.startsWith('[agri-real-price] mode=dry-run'));
    assert.ok(summary, `expected a dry-run summary log, got: ${JSON.stringify(logs)}`);
    assert.match(summary!, /status=dry-run/);
    assert.match(summary!, /wouldCreate=\d+/);
  });
});

test('BOOT WIRING production+apply, NO run-on-boot flag: NOT scheduled '
  + '(a redeploy alone never writes to production)', async () => {
  await withMode('apply', undefined, async (logs) => {
    const before = await count();
    startRealPriceIngestionIfEnabled(strapi, { delayMs: 5, fetcher: fetcher() });
    await sleep(300);
    assert.equal(logs.length, 0);
    assert.equal(calls, 0);
    assert.equal(await count(), before);
  });
});

test('BOOT WIRING production+apply WITH explicit AGRI_REAL_PRICE_RUN_ON_BOOT=true: '
  + 'runs on boot and writes the valid observations', async () => {
  await withMode('apply', 'true', async (logs, bootStrapi) => {
    const before = await count();
    startRealPriceIngestionIfEnabled(bootStrapi, { delayMs: 5, fetcher: fetcher() });
    await sleep(400);
    assert.ok((await count()) > before);
    assert.ok(logs.some((l) => l.startsWith('[agri-real-price] mode=apply') && l.includes('status=applied')));
  });
});

test('BOOT WIRING invalid mode value: treated as off, nothing scheduled', async () => {
  await withMode('YES_PLEASE', undefined, async (logs) => {
    startRealPriceIngestionIfEnabled(strapi, { delayMs: 5, fetcher: fetcher() });
    await sleep(80);
    assert.equal(logs.length, 0);
    assert.equal(calls, 0);
  });
});

test('BOOT WIRING provider completely unreachable in dry-run: still logs a summary '
  + '(provider-failed), zero writes -- never silent', async () => {
  await withMode('dry-run', undefined, async (logs, bootStrapi) => {
    const before = await count();
    startRealPriceIngestionIfEnabled(bootStrapi, {
      delayMs: 5,
      fetcher: fetcher(() => html(503)),
    });
    await sleep(300);
    assert.equal(await count(), before);
    // errors are logged via strapi.log.error, which the boot proxy tags "ERROR: "
    const summary = logs.find((l) => l.includes('[agri-real-price]'));
    assert.ok(summary, `expected a summary log even on total provider failure, got: ${JSON.stringify(logs)}`);
    assert.match(summary!, /^ERROR: /);
    assert.match(summary!, /status=provider-failed/);
  });
});
