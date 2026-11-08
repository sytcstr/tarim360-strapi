/**
 * Unit coverage for src/utils/agri-ai.ts, written for the "sessiz yerel
 * cevap" fix: a real OpenAI call that fails (timeout, non-2xx, bad JSON,
 * empty answer, network error) must now REJECT with AgriAiProviderError
 * instead of silently resolving with a disguised rules-based answer.
 * Deliberate local-answer paths (scope guard, daily limit / forceRulesOnly)
 * must keep behaving exactly as before and must never call fetch at all.
 *
 * No real network call and no real API key anywhere in this file: OPENAI_API_KEY
 * is set to a throwaway placeholder purely so agri-ai.ts's module-scope
 * `if (!OPENAI_API_KEY)` branch doesn't short-circuit every case into the
 * local fallback before `fetch` is ever reached. `globalThis.fetch` is always
 * replaced with a canned fake (same pattern as purchase-verifiers.test.ts /
 * notification-push-delivery.test.ts) and restored after every test.
 *
 * agri-ai.ts is loaded with a dynamic `import()` inside `test.before`
 * (never a static top-level import) so the env assignment below is
 * guaranteed to run first: static imports in this toolchain turned out to
 * still be hoisted ahead of this file's own top-level statements (a plain
 * `process.env.OPENAI_API_KEY = ...` placed before a static import of
 * agri-ai.ts still produced an empty key inside agri-ai.ts), so a dynamic
 * import is the only ordering that is actually reliable here.
 *
 * Run with:
 *   node --import tsx --test tests/unit/agri-ai.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'test-key-for-agri-ai-unit-tests-only';

let generateAgriAiReply: typeof import('../../src/utils/agri-ai.ts')['generateAgriAiReply'];
let AgriAiProviderError: typeof import('../../src/utils/agri-ai.ts')['AgriAiProviderError'];

test.before(async () => {
  const mod = await import('../../src/utils/agri-ai.ts');
  generateAgriAiReply = mod.generateAgriAiReply;
  AgriAiProviderError = mod.AgriAiProviderError;
});

const realFetch = globalThis.fetch;
let fetchCalls = 0;

const withFetch = async (
  impl: (url: unknown, init?: unknown) => Promise<Response> | Response,
  fn: () => Promise<void>,
) => {
  fetchCalls = 0;
  globalThis.fetch = (async (url: unknown, init?: unknown) => {
    fetchCalls += 1;
    return impl(url, init);
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
};

const openAiOk = (payload: Record<string, unknown>) =>
  new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

test('successful text request resolves with provider "openai" and photoAnalyzed=false', async () => {
  await withFetch(
    () =>
      openAiOk({
        answer: 'Yaprakta mantar baskisi olabilir.',
        suspectedIssue: 'Mantar',
        confidenceLabel: 'Orta-Yuksek',
        recommendations: ['Yakin plan foto ekle.'],
      }),
    async () => {
      const result = await generateAgriAiReply({
        prompt: 'domates yapraklarinda sararma var',
        scope: 'agriculture_tarim',
      });
      assert.equal(result.provider, 'openai');
      assert.equal(result.photoAnalyzed, false);
      assert.equal(result.answer, 'Yaprakta mantar baskisi olabilir.');
      assert.equal(fetchCalls, 1);
    },
  );
});

test('successful photo request resolves with provider "openai" and photoAnalyzed=true', async () => {
  await withFetch(
    () =>
      openAiOk({
        answer: 'Fotografta yaprak lekesi gorunuyor.',
        confidenceLabel: 'Yuksek',
        recommendations: ['Ilaclama gecmisini kontrol et.'],
      }),
    async () => {
      const result = await generateAgriAiReply({
        prompt: '',
        scope: 'agriculture_tarim',
        imageBase64: Buffer.from('fake-image-bytes').toString('base64'),
        fileName: 'leaf.jpg',
      });
      assert.equal(result.provider, 'openai');
      assert.equal(result.photoAnalyzed, true);
    },
  );
});

test('a real provider timeout rejects with AgriAiProviderError(type="timeout"), not a disguised local answer', async () => {
  await withFetch(
    () => {
      throw Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
    },
    async () => {
      await assert.rejects(
        () => generateAgriAiReply({ prompt: 'domates hastaligi', scope: 'agriculture_tarim' }),
        (err: unknown) => {
          assert.ok(err instanceof AgriAiProviderError);
          assert.equal((err as InstanceType<typeof AgriAiProviderError>).type, 'timeout');
          return true;
        },
      );
    },
  );
});

test('a non-2xx provider response rejects with AgriAiProviderError(type="http_500")', async () => {
  await withFetch(
    () => new Response('server exploded', { status: 500 }),
    async () => {
      await assert.rejects(
        () => generateAgriAiReply({ prompt: 'domates hastaligi', scope: 'agriculture_tarim' }),
        (err: unknown) => {
          assert.ok(err instanceof AgriAiProviderError);
          assert.equal((err as InstanceType<typeof AgriAiProviderError>).type, 'http_500');
          return true;
        },
      );
    },
  );
});

test('an unparseable provider response rejects with AgriAiProviderError(type="invalid_json")', async () => {
  await withFetch(
    () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'this is not json' } }] }),
        { status: 200 },
      ),
    async () => {
      await assert.rejects(
        () => generateAgriAiReply({ prompt: 'domates hastaligi', scope: 'agriculture_tarim' }),
        (err: unknown) => {
          assert.ok(err instanceof AgriAiProviderError);
          assert.equal((err as InstanceType<typeof AgriAiProviderError>).type, 'invalid_json');
          return true;
        },
      );
    },
  );
});

test('an empty answer from the provider rejects with AgriAiProviderError(type="empty_answer")', async () => {
  await withFetch(
    () => openAiOk({ answer: '', recommendations: [] }),
    async () => {
      await assert.rejects(
        () => generateAgriAiReply({ prompt: 'domates hastaligi', scope: 'agriculture_tarim' }),
        (err: unknown) => {
          assert.ok(err instanceof AgriAiProviderError);
          assert.equal((err as InstanceType<typeof AgriAiProviderError>).type, 'empty_answer');
          return true;
        },
      );
    },
  );
});

test('a raw network failure (no HTTP response at all) rejects with AgriAiProviderError(type="network")', async () => {
  await withFetch(
    () => {
      throw new Error('ECONNREFUSED');
    },
    async () => {
      await assert.rejects(
        () => generateAgriAiReply({ prompt: 'domates hastaligi', scope: 'agriculture_tarim' }),
        (err: unknown) => {
          assert.ok(err instanceof AgriAiProviderError);
          assert.equal((err as InstanceType<typeof AgriAiProviderError>).type, 'network');
          return true;
        },
      );
    },
  );
});

test('forceRulesOnly (daily limit reached) never calls the provider and returns a deliberate local answer, not an error', async () => {
  await withFetch(
    () => {
      throw new Error('must not be called when forceRulesOnly is true');
    },
    async () => {
      const result = await generateAgriAiReply({
        prompt: 'domates yapraklarinda sararma var',
        scope: 'agriculture_tarim',
        forceRulesOnly: true,
      });
      assert.equal(result.provider, 'server_rules');
      assert.equal(fetchCalls, 0);
    },
  );
});

test('an out-of-scope prompt never calls the provider and returns the scope guard reply', async () => {
  await withFetch(
    () => {
      throw new Error('must not be called for an out-of-scope prompt');
    },
    async () => {
      const result = await generateAgriAiReply({
        prompt: 'bu haftaki maç sonucu ne olur',
        scope: 'agriculture_tarim',
      });
      assert.equal(result.provider, 'scope_guard');
      assert.equal(result.photoAnalyzed, false);
      assert.equal(fetchCalls, 0);
    },
  );
});

test('a photo-only local fallback (daily limit reached, photo attached, no text) explicitly says the photo was not analyzed', async () => {
  await withFetch(
    () => {
      throw new Error('must not be called when forceRulesOnly is true');
    },
    async () => {
      const result = await generateAgriAiReply({
        prompt: '',
        scope: 'agriculture_tarim',
        imageBase64: Buffer.from('fake-image-bytes').toString('base64'),
        fileName: 'leaf.jpg',
        forceRulesOnly: true,
      });
      assert.equal(result.provider, 'server_rules');
      assert.equal(result.photoAnalyzed, false);
      assert.match(result.answer, /fotografinizin yapay zeka ile incelenmesiyle degil/i);
      assert.notEqual(result.confidenceLabel, 'Yuksek');
    },
  );
});
