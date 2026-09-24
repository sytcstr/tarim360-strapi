/**
 * Regression for the production-only "documentId engagement target -> 404"
 * bug (İlan1 Strapi production sync).
 *
 * resolveTargetRow runs inside setMembership/recordView's db.transaction.
 * On Postgres (Strapi Cloud) a failed statement ABORTS the transaction, and
 * every later statement in it fails with "current transaction is aborted".
 * The old code first called entityService.findOne(uid, <documentId string>),
 * which Strapi turns into `WHERE id = '<string>'` on an INTEGER column --
 * a Postgres error -- so the documentId fallback that followed never got to
 * run. SQLite (the integration suite's dialect) coerces types loosely and
 * never errors, so 588 integration tests could not see it.
 *
 * This fake models exactly that Postgres behavior: a non-integer `id` bind
 * throws and poisons the fake transaction; any later query then throws too.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTargetRow } from '../../src/api/engagement/services/engagement-core.ts';

const ROW = { id: 87, documentId: 'h9o2qkqj64r8lq9w4fdihma5', publishedAt: '2026-09-24T00:00:00.000Z', favoriteCount: 0 };

function makePostgresLikeStrapi() {
  const state = { aborted: false, entityCalls: [] as unknown[] };
  const guard = () => {
    if (state.aborted) throw new Error('current transaction is aborted, commands ignored until end of transaction block');
  };
  const strapi = {
    entityService: {
      findOne: async (_uid: string, id: unknown) => {
        guard();
        state.entityCalls.push(id);
        if (typeof id !== 'number') {
          state.aborted = true;
          throw new Error(`invalid input syntax for type integer: "${String(id)}"`);
        }
        return id === ROW.id ? ROW : null;
      },
    },
    db: {
      query: () => ({
        findOne: async ({ where }: { where: Record<string, unknown> }) => {
          guard();
          return where.documentId === ROW.documentId ? ROW : null;
        },
      }),
    },
  };
  return { strapi, state };
}

test('documentId target resolves even when a non-integer id would poison a Postgres transaction', async () => {
  const { strapi, state } = makePostgresLikeStrapi();
  const row = await resolveTargetRow(strapi, 'listing', ROW.documentId);
  assert.equal(row?.id, ROW.id);
  assert.deepEqual(state.entityCalls, [], 'entityService.findOne must never receive a documentId string');
  assert.equal(state.aborted, false);
});

test('numeric id (string form, as the Flutter app sends it) still resolves via entityService with a real integer', async () => {
  const { strapi, state } = makePostgresLikeStrapi();
  const row = await resolveTargetRow(strapi, 'listing', String(ROW.id));
  assert.equal(row?.id, ROW.id);
  assert.deepEqual(state.entityCalls, [ROW.id]);
});

test('unknown documentId and unknown numeric id both return null without throwing', async () => {
  const a = makePostgresLikeStrapi();
  assert.equal(await resolveTargetRow(a.strapi, 'listing', 'doesnotexist000'), null);
  const b = makePostgresLikeStrapi();
  assert.equal(await resolveTargetRow(b.strapi, 'listing', '999999'), null);
});

test('empty / whitespace id returns null', async () => {
  const { strapi } = makePostgresLikeStrapi();
  assert.equal(await resolveTargetRow(strapi, 'listing', '   '), null);
});
