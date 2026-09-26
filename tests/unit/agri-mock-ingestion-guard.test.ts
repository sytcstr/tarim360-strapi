import test from 'node:test';
import assert from 'node:assert/strict';
import { runMockAgriDataIngestion } from '../../src/services/agri-data-ingestion';
import { decideMockAgriIngestion } from '../../src/services/agri-data-ingestion/production-guard';

// A strapi whose every access explodes: a refused run must not touch it.
const explodingStrapi: any = new Proxy(
  {},
  {
    get() {
      throw new Error('strapi must not be used by a refused mock ingestion');
    },
  },
);

const withEnv = async (env: Record<string, string | undefined>, fn: () => Promise<void>) => {
  const before: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    before[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

test('production + AGRI_INGESTION_ENABLED=true: mock ingestion refuses and creates nothing', async () => {
  await withEnv({ NODE_ENV: 'production', AGRI_INGESTION_ENABLED: 'true' }, async () => {
    const summary = await runMockAgriDataIngestion(explodingStrapi);
    assert.equal(summary.skipped, true);
    assert.equal(summary.skippedReason, 'production-environment');
    assert.equal(summary.received, 0);
    assert.equal(summary.created, 0);
  });
});

test('env flags alone cannot enable mock ingestion in production / unknown / cloud environments', () => {
  const on = { AGRI_INGESTION_ENABLED: '1' };
  assert.equal(decideMockAgriIngestion({ ...on, NODE_ENV: 'production' }).allowed, false);
  assert.equal(decideMockAgriIngestion({ ...on, NODE_ENV: 'staging' }).allowed, false);
  assert.equal(decideMockAgriIngestion({ ...on }).allowed, false, 'unset NODE_ENV is not development');
  assert.equal(
    decideMockAgriIngestion({ ...on, NODE_ENV: 'development', STRAPI_CLOUD_PROJECT: 'x' }).allowed,
    false,
  );
});

test('development / test with an explicit enable keeps the previous behaviour', () => {
  assert.equal(decideMockAgriIngestion({ NODE_ENV: 'development', AGRI_INGESTION_ENABLED: 'true' }).allowed, true);
  assert.equal(decideMockAgriIngestion({ NODE_ENV: 'test', AGRI_INGESTION_ENABLED: '1' }).allowed, true);
  assert.equal(decideMockAgriIngestion({ NODE_ENV: 'development' }).allowed, false, 'still needs the explicit flag');
});
