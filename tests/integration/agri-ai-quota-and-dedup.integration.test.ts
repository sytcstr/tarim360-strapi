/**
 * Quota/double-call fix round for the AI assistant (2026-11-07 follow-up to
 * the "sessiz yerel cevap" round): proves, against a REAL Strapi instance
 * with its own throwaway SQLite database and a real HTTP server, that:
 *
 *  - the SAME question submitted twice with the SAME client-generated
 *    operationId ("Tekrar Dene") never opens a second OpenAI call and
 *    replays the original answer;
 *  - the SAME operationId with DIFFERENT content is rejected, never
 *    executed;
 *  - two requests racing for the LAST remaining daily slot ("two devices")
 *    can only ever have ONE of them actually reach the provider - the
 *    database's unique index on ai-usage-slot.slotKey arbitrates this, not
 *    an in-memory lock, so this genuinely exercises the fix in
 *    src/utils/agri-ai-quota.ts;
 *  - a client-side timeout (the test aborts its OWN fetch to the server,
 *    the server keeps processing) followed by a retry with the SAME
 *    operationId never opens a second provider call;
 *  - two different accounts never see or affect each other's quota.
 *
 * No real OpenAI call anywhere: only `globalThis.fetch` calls to
 * `api.openai.com` are intercepted; everything else (including this file's
 * own calls to the local test server) goes through the real network via
 * `realFetch`, exactly like purchase-security.integration.test.ts.
 *
 * HONESTY NOTE (verification scope): this suite runs against SQLite, like
 * every other integration test in this repo (see package.json's
 * test:integration script and every existing *.integration.test.ts file -
 * none of them boot Postgres). SQLite serializes writes from a single
 * process, so what this proves is "the claim-then-check algorithm is
 * correct and the DB unique constraint is what arbitrates the race", NOT
 * "this has been exercised under PostgreSQL's real multi-connection MVCC
 * locking". The algorithm (a unique-constraint-backed insert, retried on a
 * verified collision) is DB-agnostic and is the same mechanism this
 * codebase's own operationId pattern already relies on in production on
 * Postgres (operation-idempotency.ts, used by listing-comment/listing-share/
 * engagement/hub-content/profile-setting) - but nothing in this test run
 * can claim that production combination was itself exercised here.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import { fingerprintPayload } from '../../src/utils/operation-idempotency';

process.env.OPENAI_API_KEY = 'sk-test-fake-key-for-integration-tests-only';
process.env.AGRI_AI_DAILY_TEXT_LIMIT = '2';
process.env.AGRI_AI_DAILY_VISION_LIMIT = '2';
// Shrinks PENDING_STALE_AFTER_MS (AI_TIMEOUT_MS + 15000) to 25000ms for the
// crash-recovery test below, instead of the real default's ~50000ms -
// still real wall-clock time, just short enough for a test to wait it out.
process.env.AGRI_AI_TIMEOUT_MS = '10000';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-agri-ai-quota-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-agri-ai-quota-test.db');
const PORT = 14277;
const BASE_URL = `http://127.0.0.1:${PORT}/api`;

let strapiInstance: any;
const realFetch = globalThis.fetch;

let openAiCallCount = 0;
let openAiDelayMs = 0;
let openAiShouldFail = false;

const openAiAnswerFor = (promptText: string) =>
  JSON.stringify({
    choices: [
      {
        message: {
          content: JSON.stringify({
            answer: `Gercek model cevabi: ${promptText}`,
            suspectedIssue: 'Test suphesi',
            confidenceLabel: 'Orta-Yuksek',
            recommendations: ['Oneri 1', 'Oneri 2'],
          }),
        },
      },
    ],
  });

before(async () => {
  globalThis.fetch = (async (url: any, init?: any) => {
    const u = String(url);
    if (u.startsWith('https://api.openai.com/')) {
      openAiCallCount += 1;
      if (openAiDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, openAiDelayMs));
      }
      if (openAiShouldFail) {
        return new Response('provider down', { status: 500 });
      }
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const userMsg = Array.isArray(body?.messages)
        ? body.messages.find((m: any) => m.role === 'user')
        : null;
      const promptText =
        typeof userMsg?.content === 'string'
          ? userMsg.content
          : Array.isArray(userMsg?.content)
            ? asString(userMsg.content.find((c: any) => c.type === 'text')?.text)
            : 'bilinmeyen';
      return new Response(openAiAnswerFor(promptText), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(url, init);
  }) as typeof fetch;

  if (existsSync(TEST_DB_FILE)) unlinkSync(TEST_DB_FILE);
  process.env.DATABASE_CLIENT = 'sqlite';
  process.env.DATABASE_FILENAME = TEST_DB_FILE_RELATIVE;
  process.env.PORT = String(PORT);
  const compiled = await compileStrapi();
  strapiInstance = await createStrapi(compiled).load();
  await strapiInstance.server.listen(PORT);
});

after(async () => {
  globalThis.fetch = realFetch;
  await strapiInstance?.server?.close?.();
  await strapiInstance?.destroy?.();
  if (existsSync(TEST_DB_FILE)) unlinkSync(TEST_DB_FILE);
});

// ---- helpers ---------------------------------------------------------------------------
const asString = (value: unknown): string => String(value ?? '').trim();
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

  // Registration never creates a profile-setting row (that only happens
  // lazily from engagement/promo/purchase flows) - find-or-create it here,
  // mirroring purchase/lib/persistence.ts's own upsert shape.
  const activePremium = { planTitle: 'Pro Premium (12 Ay)', hasAiAssistant: true };
  const existingProfile = await strapiInstance.db
    .query('api::profile-setting.profile-setting')
    .findOne({ where: { profileId: ownerId } });
  if (existingProfile?.id) {
    await strapiInstance.db.query('api::profile-setting.profile-setting').update({
      where: { id: existingProfile.id },
      data: { activePremium, activePremiumSubscription: activePremium },
    });
  } else {
    await strapiInstance.entityService.create('api::profile-setting.profile-setting' as any, {
      data: { profileId: ownerId, activePremium, activePremiumSubscription: activePremium },
    });
  }

  return { jwt, email, ownerId };
}

const post = async (
  url: string,
  jwt: string,
  body: unknown,
  opts: { signal?: AbortSignal } = {},
) => {
  const res = await realFetch(`${BASE_URL}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const askText = (jwt: string, operationId: string, prompt: string, opts: { signal?: AbortSignal } = {}) =>
  post(
    '/ai/agri-assistant',
    jwt,
    { operationId, prompt, rawPrompt: prompt, scope: 'agriculture' },
    opts,
  );

const slotCountFor = async (ownerProfileId: string, channel: string) =>
  strapiInstance.db.query('api::ai-usage-slot.ai-usage-slot').count({
    where: { ownerProfileId, channel },
  });

/** Sends the exact JSON an OLD client (no operationId support at all) would
 * send - the field is simply absent, not empty-string. */
const askTextNoOperationId = (jwt: string, prompt: string) =>
  post('/ai/agri-assistant', jwt, { prompt, rawPrompt: prompt, scope: 'agriculture' });

const askVisionNoOperationId = (jwt: string, imageBase64: string) =>
  post('/ai/agri-vision', jwt, { prompt: '', imageBase64, fileName: 'leaf.jpg' });

// ---- tests -------------------------------------------------------------------------------

test('the same question submitted twice with the same operationId calls the provider once and replays the original answer', async () => {
  openAiDelayMs = 0;
  openAiShouldFail = false;
  const user = await registerWithAiAccess('dedup');
  const operationId = crypto.randomUUID();
  const prompt = 'domates yapraklarinda leke var, ilk ne kontrol etmeliyim';

  const before1 = openAiCallCount;
  const first = await askText(user.jwt, operationId, prompt);
  assert.equal(first.status, 200);
  assert.equal(first.body?.data?.provider, 'openai');
  assert.equal(openAiCallCount, before1 + 1);

  const second = await askText(user.jwt, operationId, prompt);
  assert.equal(second.status, 200);
  assert.equal(
    second.body?.data?.answer,
    first.body?.data?.answer,
    'retry with the same operationId must replay the original answer',
  );
  assert.equal(
    openAiCallCount,
    before1 + 1,
    'no second provider call for the same operationId + same content',
  );
});

test('the same operationId with different content is rejected, not executed', async () => {
  openAiDelayMs = 0;
  openAiShouldFail = false;
  const user = await registerWithAiAccess('conflict');
  const operationId = crypto.randomUUID();

  const first = await askText(user.jwt, operationId, 'sut verimi dustu, yem degisikligi yaptik');
  assert.equal(first.status, 200);

  const before1 = openAiCallCount;
  const second = await askText(user.jwt, operationId, 'tamamen farkli bir soru: traktor calismiyor');
  assert.equal(second.status, 400);
  assert.equal(openAiCallCount, before1, 'a rejected conflicting retry must never reach the provider');
});

test('two requests racing for the last remaining daily slot: only one reaches the provider, the other gets a deliberate local/limit answer', async () => {
  openAiDelayMs = 50;
  openAiShouldFail = false;
  const user = await registerWithAiAccess('race');

  // AGRI_AI_DAILY_TEXT_LIMIT=2 for this whole file. Spend slot 0 first so
  // the two concurrent requests below race for the single remaining slot.
  const warmup = await askText(user.jwt, crypto.randomUUID(), 'ilk soru: domates hastaligi');
  assert.equal(warmup.status, 200);
  assert.equal(warmup.body?.data?.provider, 'openai');

  const before1 = openAiCallCount;
  const opB = crypto.randomUUID();
  const opC = crypto.randomUUID();
  const [resB, resC] = await Promise.all([
    askText(user.jwt, opB, 'ikinci cihaz sorusu B: sulama sistemi ariza'),
    askText(user.jwt, opC, 'ikinci cihaz sorusu C: hidrolik basinc dusuk'),
  ]);

  assert.equal(openAiCallCount, before1 + 1, 'exactly one of the two racing requests must reach the provider');

  const providers = [resB.body?.data?.provider, resC.body?.data?.provider];
  const forceFlags = [resB.body?.data?.forceRulesOnly, resC.body?.data?.forceRulesOnly];
  assert.equal(providers.filter((p) => p === 'openai').length, 1, 'exactly one winner got the real answer');
  assert.equal(forceFlags.filter((f) => f === true).length, 1, 'exactly one loser was told the daily limit was reached');

  const finalSlotCount = await slotCountFor(user.ownerId, 'text');
  assert.equal(finalSlotCount, 2, 'exactly limit (2) slots are ever consumed for this owner/day/channel');
});

test('a client-side timeout followed by a retry with the same operationId never opens a second provider call', async () => {
  openAiDelayMs = 500;
  openAiShouldFail = false;
  const user = await registerWithAiAccess('timeout');
  const operationId = crypto.randomUUID();
  const prompt = 'zararli bocek baskisi var, ne yapmaliyim';

  const before1 = openAiCallCount;
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), 150);
  await assert.rejects(
    () => askText(user.jwt, operationId, prompt, { signal: controller.signal }),
    /abort/i,
    'the test itself gives up before the (artificially slow) provider responds',
  );
  clearTimeout(abortTimer);

  // The server kept processing in the background after the client gave up;
  // give it time to actually finish and persist the completed ai-request row.
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(openAiCallCount, before1 + 1, 'the abandoned client request still only made one real provider call');

  const retry = await askText(user.jwt, operationId, prompt);
  assert.equal(retry.status, 200);
  assert.equal(retry.body?.data?.provider, 'openai');
  assert.equal(
    openAiCallCount,
    before1 + 1,
    'retrying with the same operationId after a client timeout must not open a second provider call',
  );
});

test('two different accounts never see or affect each other\'s daily quota', async () => {
  openAiDelayMs = 0;
  openAiShouldFail = false;
  const a = await registerWithAiAccess('acct-a');
  const b = await registerWithAiAccess('acct-b');

  // Exhaust account A's 2-slot daily limit.
  await askText(a.jwt, crypto.randomUUID(), 'A sorusu 1: domates');
  await askText(a.jwt, crypto.randomUUID(), 'A sorusu 2: biber');
  const aThird = await askText(a.jwt, crypto.randomUUID(), 'A sorusu 3: patates');
  assert.equal(aThird.body?.data?.forceRulesOnly, true, "account A's own limit is now reached");

  // Account B, a completely separate owner, must still have its full quota.
  const bFirst = await askText(b.jwt, crypto.randomUUID(), 'B sorusu 1: hayvan hastaligi');
  assert.equal(bFirst.status, 200);
  assert.equal(bFirst.body?.data?.provider, 'openai');
  assert.equal(bFirst.body?.data?.forceRulesOnly, false, "account B is not affected by account A's usage");

  const summaryRes = await realFetch(`${BASE_URL}/ai/usage-summary`, {
    headers: { authorization: `Bearer ${b.jwt}` },
  });
  const summary = (await summaryRes.json()).data;
  assert.equal(summary.textRemoteCount, 1, "B's own usage-summary reflects only B's own usage");
});

test('an OLD client that never sends operationId still gets a real working AI reply, with subscription/scope/quota enforced', async () => {
  openAiDelayMs = 0;
  openAiShouldFail = false;
  const user = await registerWithAiAccess('old-client-text');

  const r1 = await askTextNoOperationId(user.jwt, 'domates yapraklarinda leke var, ilk ne kontrol etmeliyim');
  assert.equal(r1.status, 200, 'an old client with no operationId field still gets a working reply, not a 400');
  assert.equal(r1.body?.data?.provider, 'openai');
  assert.equal(r1.body?.data?.forceRulesOnly, false);

  // AGRI_AI_DAILY_TEXT_LIMIT=2 for this file - quota is still enforced for
  // an old client exactly like a new one, even though each of its requests
  // is necessarily treated as independent (no dedup guarantee without a
  // client-supplied id to tie retries together - expected and accepted).
  const r2 = await askTextNoOperationId(user.jwt, 'sut verimi dustu, yem degisikligi yaptik');
  assert.equal(r2.body?.data?.provider, 'openai');
  const r3 = await askTextNoOperationId(user.jwt, 'traktorde hidrolik basinc dustu');
  assert.equal(r3.body?.data?.forceRulesOnly, true, "the old client's 3rd request still hits the real daily limit");

  // A present-but-malformed operationId (not simply absent) is a different
  // situation - the caller IS trying to use the idempotency contract and
  // getting it wrong - that must still be rejected exactly as before.
  const bad = await post('/ai/agri-assistant', user.jwt, {
    operationId: 'not-a-uuid',
    prompt: 'domates yapraklarinda leke var',
    rawPrompt: 'domates yapraklarinda leke var',
    scope: 'agriculture',
  });
  assert.equal(bad.status, 400);
});

test('an OLD client (no operationId) on /ai/agri-vision also gets a real working reply', async () => {
  openAiDelayMs = 0;
  openAiShouldFail = false;
  const user = await registerWithAiAccess('old-client-vision');
  const imageBase64 = Buffer.from('fake-jpeg-bytes-for-test').toString('base64');

  const r = await askVisionNoOperationId(user.jwt, imageBase64);
  assert.equal(r.status, 200, 'an old client with no operationId field still gets a working vision reply, not a 400');
  assert.equal(r.body?.data?.provider, 'openai');
  assert.equal(r.body?.data?.photoAnalyzed, true);
});

test('a stale pending request (simulating a real server crash after the provider may have already answered) never opens a second provider call and never holds the quota slot hostage', async () => {
  openAiDelayMs = 0;
  openAiShouldFail = false;
  const user = await registerWithAiAccess('crash-recovery');
  const operationId = crypto.randomUUID();
  const prompt = 'zararli bocek baskisi var, ne yapmaliyim once';
  const fingerprint = fingerprintPayload({
    channel: 'text',
    ownerId: user.ownerId,
    prompt,
    rawPrompt: prompt,
    scope: 'agriculture',
    imageBase64: '',
    fileName: '',
  });
  const today = new Date();
  const dayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

  // Directly seed exactly what a real crash leaves behind: a 'pending'
  // ai-request row that will NEVER transition on its own (no in-process
  // handler survived to finish it), plus the ai-usage-slot it had already
  // claimed - whether the provider itself was actually reached before the
  // crash is deliberately left unknown/unmodeled, since that is the whole
  // point: the system cannot tell either, and must not guess.
  await strapiInstance.entityService.create('api::ai-request.ai-request', {
    data: {
      operationId,
      payloadFingerprint: fingerprint,
      ownerProfileId: user.ownerId,
      hasImage: false,
      status: 'pending',
    },
  });
  await strapiInstance.entityService.create('api::ai-usage-slot.ai-usage-slot', {
    data: {
      slotKey: `${user.ownerId}:${dayKey}:text:0`,
      ownerProfileId: user.ownerId,
      dayKey,
      channel: 'text',
      operationId,
    },
  });

  const before1 = openAiCallCount;

  const immediate = await askText(user.jwt, operationId, prompt);
  assert.equal(immediate.status, 409, 'a fresh-looking pending row is still reported as in-progress');
  assert.equal(openAiCallCount, before1, 'no provider call while the row still looks fresh');
  assert.equal(await slotCountFor(user.ownerId, 'text'), 1, 'the simulated-crash slot is untouched while still fresh');

  // Real wall-clock wait past PENDING_STALE_AFTER_MS (10000+15000=25000ms
  // with this file's shortened AGRI_AI_TIMEOUT_MS).
  await new Promise((resolve) => setTimeout(resolve, 27000));

  const afterStale = await askText(user.jwt, operationId, prompt);
  assert.equal(afterStale.status, 422, 'a stale pending request is reported as unverified, not silently retried');
  assert.equal(afterStale.body?.error?.name, 'RequestUnverified');
  assert.equal(
    openAiCallCount,
    before1,
    'the critical assertion: a stale pending retry under the SAME operationId must NEVER open a second provider call',
  );
  assert.equal(
    await slotCountFor(user.ownerId, 'text'),
    0,
    'the abandoned slot is released, not held hostage - the user does not permanently lose this unit of quota',
  );

  // The SAME (now terminal 'unknown') operationId must stay refused forever
  // - never reopen a provider call under it, no matter how many times it
  // comes back.
  const sameIdAgain = await askText(user.jwt, operationId, prompt);
  assert.equal(sameIdAgain.status, 422);
  assert.equal(sameIdAgain.body?.error?.name, 'RequestUnverified');
  assert.equal(openAiCallCount, before1, 'the terminal id still never calls the provider, however many times it is retried');

  // A genuinely NEW request (new operationId, same owner) proves the freed
  // slot is real and usable - the user is told to start over, and starting
  // over actually works.
  const freshRequest = await askText(user.jwt, crypto.randomUUID(), prompt);
  assert.equal(freshRequest.status, 200);
  assert.equal(freshRequest.body?.data?.provider, 'openai');
  assert.equal(openAiCallCount, before1 + 1, 'exactly one real provider call total across this whole scenario');
});
