/**
 * PostgreSQL-ONLY race verification for the AI assistant's atomic quota
 * (agri-ai-quota.ts). Every other integration test in this repo (including
 * agri-ai-quota-and-dedup.integration.test.ts) runs against SQLite, which
 * serializes writes from a single process - it proves the claim-then-check
 * ALGORITHM is correct, not that it has been exercised under PostgreSQL's
 * real multi-connection MVCC locking. This file is that missing proof.
 *
 * It does NOT run under `npm run test:integration` (that glob picks up
 * every *.test.ts file, which would silently fall back to SQLite and give
 * a false sense of Postgres coverage) - it is meant to be run on its own,
 * pointed at an ISOLATED, DISPOSABLE Postgres database, with
 * DATABASE_CLIENT=postgres set.
 *
 * SAFETY: refuses to run at all unless DATABASE_CLIENT is exactly
 * 'postgres' (fails loudly in `before()` otherwise - never silently runs
 * against SQLite and lets that be mistaken for Postgres coverage), and then
 * independently confirms the live connection really is Postgres by running
 * `select version()` through it before trusting anything else. Never
 * creates or drops a database/schema itself - the caller must point
 * DATABASE_NAME at a database that already exists and is safe to write
 * throwaway test rows into. No real OpenAI call: only `globalThis.fetch`
 * calls to api.openai.com are intercepted.
 *
 * ---- HOW TO RUN -----------------------------------------------------
 * Prerequisites (none of this exists in the sandbox this suite was written
 * in - no PostgreSQL binary, no Docker, no reachable Postgres server):
 *   1. A running, reachable PostgreSQL server with an empty/disposable
 *      database the test may write rows into (do NOT point this at a
 *      production or shared database).
 *   2. The `pg` npm package installed in tarim360-strapi (NOT currently a
 *      dependency of this project - `npm install pg` first; this is a
 *      one-time local/CI setup step, not something to commit without the
 *      maintainer's say-so since it changes package.json/package-lock.json).
 *
 * Quickest local option (Docker):
 *   docker run --rm -d --name tarim360-ai-quota-pg \
 *     -e POSTGRES_PASSWORD=test -e POSTGRES_DB=tarim360_ai_quota_test \
 *     -p 5433:5432 postgres:16
 *   npm install pg
 *   DATABASE_CLIENT=postgres DATABASE_HOST=127.0.0.1 DATABASE_PORT=5433 \
 *   DATABASE_NAME=tarim360_ai_quota_test DATABASE_USERNAME=postgres \
 *   DATABASE_PASSWORD=test \
 *   node --import tsx --test tests/integration/agri-ai-quota-postgres-race.integration.test.ts
 *   docker stop tarim360-ai-quota-pg
 *
 * Equivalent against any already-running PostgreSQL instance / CI service
 * container - just point the DATABASE_* vars at it:
 *   DATABASE_CLIENT=postgres DATABASE_HOST=<host> DATABASE_PORT=<port> \
 *   DATABASE_NAME=<disposable_db> DATABASE_USERNAME=<user> DATABASE_PASSWORD=<pass> \
 *   node --import tsx --test tests/integration/agri-ai-quota-postgres-race.integration.test.ts
 * -----------------------------------------------------------------------
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// This file is picked up by the same tests/integration/**/*.test.ts glob as
// every SQLite-backed integration test (npm run test:integration), so it
// must never hard-fail that normal run just because Postgres isn't
// configured there - it SKIPS instead, with a clear reason, and only runs
// for real when DATABASE_CLIENT=postgres is explicitly set (see this file's
// header comment for the full run command). This is also the guard against
// "Mevcut SQLite testini doğrudan PostgreSQL'de koşmuş sayma": a run
// without DATABASE_CLIENT=postgres proves nothing here and is reported as
// skipped, never as passed.
const RUNNING_ON_POSTGRES = (process.env.DATABASE_CLIENT || '').trim() === 'postgres';
const SKIP_REASON = RUNNING_ON_POSTGRES
  ? false
  : `requires DATABASE_CLIENT=postgres pointed at an isolated test database ` +
    `(got ${JSON.stringify(process.env.DATABASE_CLIENT || '(unset)')}) - see this file's ` +
    `header comment for the exact prerequisites and run command; not run as part of the ` +
    `normal SQLite-backed test:integration suite`;

process.env.OPENAI_API_KEY = 'sk-test-fake-key-for-postgres-race-tests-only';
// A single shared daily cap of 1 for this whole file keeps both scenarios
// simple: whoever first claims the owner's one slot for the day wins.
process.env.AGRI_AI_DAILY_TEXT_LIMIT = '1';
process.env.AGRI_AI_DAILY_VISION_LIMIT = '1';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const PORT = 14333;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

let strapiInstance: any;
const realFetch = globalThis.fetch;

let openAiCallCount = 0;
let openAiDelayMs = 0;

const openAiAnswerFor = (promptText: string) =>
  JSON.stringify({
    choices: [
      {
        message: {
          content: JSON.stringify({
            answer: `Gercek model cevabi (postgres): ${promptText}`,
            suspectedIssue: 'Test suphesi',
            confidenceLabel: 'Orta-Yuksek',
            recommendations: ['Oneri 1', 'Oneri 2'],
          }),
        },
      },
    ],
  });

before(async () => {
  if (!RUNNING_ON_POSTGRES) return;
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.startsWith('https://api.openai.com/')) {
      openAiCallCount += 1;
      if (openAiDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, openAiDelayMs));
      }
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const userMsg = Array.isArray(body?.messages)
        ? body.messages.find((m: any) => m.role === 'user')
        : null;
      const promptText =
        typeof userMsg?.content === 'string' ? userMsg.content : 'bilinmeyen';
      return new Response(openAiAnswerFor(promptText), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(url, init);
  }) as typeof fetch;

  process.env.PORT = String(PORT);
  const compiled = await compileStrapi();
  strapiInstance = await createStrapi(compiled).load();
  await strapiInstance.server.listen(PORT);

  // Independent proof this is REALLY PostgreSQL, not just DATABASE_CLIENT
  // claiming to be - a live query, not a config read.
  const versionRow = await strapiInstance.db.connection.raw('select version()');
  const versionString: string = versionRow?.rows?.[0]?.version ?? '';
  // eslint-disable-next-line no-console
  console.log('[agri-ai-quota-postgres-race] connected to:', versionString);
  assert.match(
    versionString.toLowerCase(),
    /postgresql/,
    'the live `select version()` result must actually say PostgreSQL - a misconfigured ' +
      'DATABASE_CLIENT that silently connected to something else must not pass as Postgres coverage',
  );
});

after(async () => {
  if (!RUNNING_ON_POSTGRES) return;
  globalThis.fetch = realFetch;
  await strapiInstance?.server?.close?.();
  await strapiInstance?.destroy?.();
  // Deliberately does NOT drop tables or the database - this suite only
  // ever writes rows scoped to its own randomly-generated owner ids, and
  // the caller's disposable test database is theirs to tear down.
});

// ---- helpers ---------------------------------------------------------------------------
const uid = () => crypto.randomUUID().slice(0, 8);

async function registerWithAiAccess(tag: string) {
  const email = `${tag}-${uid()}@test.local`;
  const res = await realFetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password: 'Passw0rd!123' }),
  });
  const body = await res.json();
  const jwt = body.jwt as string;
  const ownerId = `u_${email.toLowerCase().replace(/[^a-z0-9]/g, '_')}`;

  const activePremium = { planTitle: 'Pro Premium (12 Ay)', hasAiAssistant: true };
  await strapiInstance.entityService.create('api::profile-setting.profile-setting', {
    data: { profileId: ownerId, activePremium, activePremiumSubscription: activePremium },
  });

  return { jwt, email, ownerId };
}

const post = async (url: string, jwt: string, body: unknown) => {
  const res = await realFetch(`${BASE_URL}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const askText = (jwt: string, operationId: string, prompt: string) =>
  post('/ai/agri-assistant', jwt, { operationId, prompt, rawPrompt: prompt, scope: 'agriculture' });

const slotCountFor = async (ownerProfileId: string, channel: string) =>
  strapiInstance.db.query('api::ai-usage-slot.ai-usage-slot').count({
    where: { ownerProfileId, channel },
  });

const dayKeyFor = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---- scenario 1: two requests race for the one-and-only remaining daily slot --------------

test(
  'PostgreSQL: two requests racing for the last remaining daily slot - only one reaches the provider, quota is never exceeded',
  { skip: SKIP_REASON },
  async () => {
  openAiDelayMs = 50; // widen the race window
  const user = await registerWithAiAccess('pg-race-last-slot');

  const before1 = openAiCallCount;
  const opA = crypto.randomUUID();
  const opB = crypto.randomUUID();
  const [resA, resB] = await Promise.all([
    askText(user.jwt, opA, 'pg yarisi A: domates yapraklarinda leke var'),
    askText(user.jwt, opB, 'pg yarisi B: sulama sistemi ariza yapti'),
  ]);

  const providerCallsMade = openAiCallCount - before1;
  const finalSlotCount = await slotCountFor(user.ownerId, 'text');
  const providers = [resA.body?.data?.provider, resB.body?.data?.provider];
  const forceFlags = [resA.body?.data?.forceRulesOnly, resB.body?.data?.forceRulesOnly];

  // eslint-disable-next-line no-console
  console.log('[scenario 1: last remaining slot] fake provider calls made:', providerCallsMade);
  // eslint-disable-next-line no-console
  console.log('[scenario 1: last remaining slot] final ai-usage-slot count for this owner/day/channel:', finalSlotCount);
  // eslint-disable-next-line no-console
  console.log('[scenario 1: last remaining slot] providers:', providers, 'forceRulesOnly flags:', forceFlags);

  assert.equal(providerCallsMade, 1, 'exactly one of the two racing requests must reach the provider');
  assert.equal(providers.filter((p) => p === 'openai').length, 1, 'exactly one winner got the real answer');
  assert.equal(forceFlags.filter((f) => f === true).length, 1, 'exactly one loser was told the daily limit was reached');
  assert.equal(finalSlotCount, 1, 'quota is never exceeded: exactly the configured limit (1) slot is ever consumed');
  },
);

// ---- scenario 2: two requests race to reclaim the SAME abandoned reservation --------------

test(
  'PostgreSQL: two requests racing to reclaim the same abandoned (crashed) reservation - only one reaches the provider, quota is never exceeded',
  { skip: SKIP_REASON },
  async () => {
  openAiDelayMs = 50;
  const user = await registerWithAiAccess('pg-race-abandoned');
  const dayKey = dayKeyFor(new Date());

  // Seed exactly what a real crash leaves behind: a 'pending' ai-request row
  // that will never transition on its own, plus the ai-usage-slot it had
  // already claimed - with AGRI_AI_DAILY_TEXT_LIMIT=1 this is the owner's
  // ENTIRE daily capacity, currently held hostage by an abandoned attempt.
  const crashedOperationId = crypto.randomUUID();
  await strapiInstance.entityService.create('api::ai-request.ai-request', {
    data: {
      operationId: crashedOperationId,
      payloadFingerprint: 'irrelevant-for-this-seeded-row',
      ownerProfileId: user.ownerId,
      hasImage: false,
      status: 'unknown', // already given up on, exactly like releaseUsageSlotByOperationId's target state - but the SLOT below was deliberately left behind to simulate it not having been cleaned up yet by that path, so claimUsageSlot's own reclaim-on-claim logic is what must free it here.
    },
  });
  await strapiInstance.entityService.create('api::ai-usage-slot.ai-usage-slot', {
    data: {
      slotKey: `${user.ownerId}:${dayKey}:text:0`,
      ownerProfileId: user.ownerId,
      dayKey,
      channel: 'text',
      operationId: crashedOperationId,
    },
  });
  assert.equal(await slotCountFor(user.ownerId, 'text'), 1, 'the seeded abandoned reservation occupies the owner\'s only slot');

  const before1 = openAiCallCount;
  const opC = crypto.randomUUID();
  const opD = crypto.randomUUID();
  const [resC, resD] = await Promise.all([
    askText(user.jwt, opC, 'pg yarisi C: hidrolik basinc dustu'),
    askText(user.jwt, opD, 'pg yarisi D: zararli bocek baskisi var'),
  ]);

  const providerCallsMade = openAiCallCount - before1;
  const finalSlotCount = await slotCountFor(user.ownerId, 'text');
  const providers = [resC.body?.data?.provider, resD.body?.data?.provider];
  const forceFlags = [resC.body?.data?.forceRulesOnly, resD.body?.data?.forceRulesOnly];

  // eslint-disable-next-line no-console
  console.log('[scenario 2: abandoned reservation] fake provider calls made:', providerCallsMade);
  // eslint-disable-next-line no-console
  console.log('[scenario 2: abandoned reservation] final ai-usage-slot count for this owner/day/channel:', finalSlotCount);
  // eslint-disable-next-line no-console
  console.log('[scenario 2: abandoned reservation] providers:', providers, 'forceRulesOnly flags:', forceFlags);

  assert.equal(providerCallsMade, 1, 'exactly one of the two requests racing to reclaim the abandoned slot must reach the provider');
  assert.equal(providers.filter((p) => p === 'openai').length, 1, 'exactly one winner reclaimed the slot and got the real answer');
  assert.equal(forceFlags.filter((f) => f === true).length, 1, 'exactly one loser found the (now freshly-claimed) capacity already gone');
  assert.equal(
    finalSlotCount,
    1,
    'quota is never exceeded even across a reclaim race: still exactly the configured limit (1) slot, never 0 and never 2',
  );
  },
);
