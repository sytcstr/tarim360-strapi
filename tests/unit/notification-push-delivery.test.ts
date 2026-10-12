/**
 * Unit tests for deliverPush (src/api/notification/content-types/
 * notification/lifecycles.ts) -- the push-status reporting accuracy pass
 * from the "Çiftçiden Sorular" audit's FCM follow-up.
 *
 * No real network call and no real credential anywhere in this file:
 * - The "not configured" cases exercise the REAL `sendFcmLegacyPush` path
 *   with every FCM env var genuinely unset (confirmed concretely during
 *   this same audit: this repo's own local `.env` has none of them) --
 *   `sendViaLegacy` returns `skipped: true` synchronously, before any
 *   `fetch` call is ever made.
 * - The "a real attempt happened" cases temporarily replace the global
 *   `fetch` with a canned fake (restored in `finally`) so the legacy FCM
 *   HTTP shape can be exercised deterministically, still with zero real
 *   credentials and zero real network I/O.
 *
 * Run with:
 *   node --test tests/unit/notification-push-delivery.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { deliverPush } from '../../src/api/notification/content-types/notification/lifecycles.ts';

const FCM_ENV_KEYS = [
  'FIREBASE_PROJECT_ID',
  'GOOGLE_CLOUD_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'GOOGLE_SERVICE_ACCOUNT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
  'GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY',
  'FCM_SERVER_KEY',
];

/** Saves every FCM-related env var, clears them all, runs `fn`, restores
 * the originals -- so this file never depends on (and never leaks into)
 * whatever this process's real environment happens to have set. */
async function withNoFcmConfig(fn: () => Promise<void>) {
  const saved = new Map<string, string | undefined>();
  for (const k of FCM_ENV_KEYS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Minimal fake strapi: `profileSettingRows` backs the
 * profile-setting findMany/findOne lookups deliverPush does; every
 * `db.query('api::notification.notification').update(...)` call (the
 * actual pushStatus write this test asserts on) is captured in
 * `notificationUpdates`. */
function makeFakeStrapi(profileSettingRows: Array<Record<string, unknown>>) {
  const notificationUpdates: Array<Record<string, unknown>> = [];
  const profileSettingUpdates: Array<Record<string, unknown>> = [];
  const strapi = {
    log: { warn: () => {}, info: () => {} },
    db: {
      query(uid: string) {
        if (uid === 'api::profile-setting.profile-setting') {
          return {
            findMany: async () => profileSettingRows,
            findOne: async ({ where }: any) => {
              const wantedId = where?.profileId?.$eq;
              return profileSettingRows.find((r) => r.profileId === wantedId) ?? null;
            },
            update: async (args: any) => {
              profileSettingUpdates.push(args);
            },
          };
        }
        if (uid === 'api::notification.notification') {
          return {
            update: async (args: any) => {
              notificationUpdates.push(args);
            },
          };
        }
        throw new Error(`unexpected uid in fake db.query: ${uid}`);
      },
    },
  };
  return { strapi, notificationUpdates, profileSettingUpdates };
}

const baseRow = () => ({
  id: 1,
  // Deliberately NOT prefixed with `n_` -- that prefix is reserved for the
  // Flutter client's own locally-generated ids (NotificationStore.add's
  // `n_$_seq`), which `isClientSideLocalNotification` correctly treats as
  // "never push this, it was never meant to be a remote target push" and
  // skips before even reaching the FCM logic this file tests.
  notificationId: 'comment_remote_test_1',
  kind: 'comment',
  title: 'Test bildirimi',
  message: 'Test mesaji',
  targetProfileId: 'u_target',
  isRead: false,
});

test('no FCM credentials configured at all: pushStatus is "skipped", never "failed" -- the real bug this audit found and fixed', async () => {
  await withNoFcmConfig(async () => {
    const { strapi, notificationUpdates } = makeFakeStrapi([
      { id: 10, profileId: 'u_target', fcmTokens: ['tok_AAAAAAAAAAAAAAAAAAAA'] },
    ]);
    await deliverPush(strapi, baseRow());
    assert.equal(notificationUpdates.length, 1);
    assert.equal(notificationUpdates[0].data.pushStatus, 'skipped');
    assert.equal(notificationUpdates[0].data.sentAt, null);
    assert.ok(
      String(notificationUpdates[0].data.pushError ?? '').length > 0,
      'the specific reason (missing config) should be recorded, not silently dropped',
    );
  });
});

test('target has no registered FCM token at all: pushStatus is "skipped" (never "failed"), and no FCM call is even attempted', async () => {
  await withNoFcmConfig(async () => {
    const { strapi, notificationUpdates } = makeFakeStrapi([
      { id: 10, profileId: 'u_target', fcmTokens: [] },
    ]);
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async (...args: unknown[]) => {
      fetchCalled = true;
      return originalFetch(...(args as Parameters<typeof fetch>));
    }) as typeof fetch;
    try {
      await deliverPush(strapi, baseRow());
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.equal(fetchCalled, false, 'no token to push to -- FCM must never even be called');
    assert.equal(notificationUpdates[0].data.pushStatus, 'skipped');
  });
});

test('in-app notification creation is never affected by push outcome (deliverPush only ever UPDATES an already-created row, never deletes/hides it)', async () => {
  await withNoFcmConfig(async () => {
    const { strapi, notificationUpdates } = makeFakeStrapi([
      { id: 10, profileId: 'u_target', fcmTokens: ['tok_AAAAAAAAAAAAAAAAAAAA'] },
    ]);
    await deliverPush(strapi, baseRow());
    // The only write deliverPush issues against the notification row is a
    // status-field UPDATE -- no delete, no `data` touching isRead/title/
    // message/notificationId (the fields the in-app list actually reads).
    const data = notificationUpdates[0].data as Record<string, unknown>;
    assert.deepEqual(Object.keys(data).sort(), ['pushError', 'pushStatus', 'sentAt']);
  });
});

test('a real attempt that genuinely succeeds for every token: pushStatus is "sent" (FCM accepted the request -- this is not itself device-delivery proof)', async () => {
  process.env.FCM_SERVER_KEY = 'fake-legacy-server-key-for-this-test-only';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ success: 1, results: [{ message_id: 'm1' }] }), {
      status: 200,
    })) as typeof fetch;
  try {
    const { strapi, notificationUpdates } = makeFakeStrapi([
      { id: 10, profileId: 'u_target', fcmTokens: ['tok_AAAAAAAAAAAAAAAAAAAA'] },
    ]);
    await deliverPush(strapi, baseRow());
    assert.equal(notificationUpdates[0].data.pushStatus, 'sent');
    assert.ok(notificationUpdates[0].data.sentAt, 'sentAt is set once FCM accepted the request');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.FCM_SERVER_KEY;
  }
});

test('a real attempt where FCM reports the token as invalid: pushStatus is "failed" (the only token available was rejected), and the bad token is pruned from that profile', async () => {
  process.env.FCM_SERVER_KEY = 'fake-legacy-server-key-for-this-test-only';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ success: 0, results: [{ error: 'NotRegistered' }] }),
      { status: 200 },
    )) as typeof fetch;
  try {
    const { strapi, notificationUpdates, profileSettingUpdates } = makeFakeStrapi([
      { id: 10, profileId: 'u_target', fcmTokens: ['tok_AAAAAAAAAAAAAAAAAAAA'] },
    ]);
    await deliverPush(strapi, baseRow());
    assert.equal(notificationUpdates[0].data.pushStatus, 'failed');
    assert.equal(profileSettingUpdates.length, 1, 'the invalid token must be pruned');
    assert.deepEqual(profileSettingUpdates[0].data.fcmTokens, []);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.FCM_SERVER_KEY;
  }
});

test('a real attempt with a mix of one valid and one invalid token: pushStatus is "partial"', async () => {
  process.env.FCM_SERVER_KEY = 'fake-legacy-server-key-for-this-test-only';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        success: 1,
        results: [{ message_id: 'm1' }, { error: 'InvalidRegistration' }],
      }),
      { status: 200 },
    )) as typeof fetch;
  try {
    const { strapi, notificationUpdates, profileSettingUpdates } = makeFakeStrapi([
      {
        id: 10,
        profileId: 'u_target',
        fcmTokens: ['tok_AAAAAAAAAAAAAAAAAAAA', 'tok_BBBBBBBBBBBBBBBBBBBB'],
      },
    ]);
    await deliverPush(strapi, baseRow());
    assert.equal(notificationUpdates[0].data.pushStatus, 'partial');
    assert.deepEqual(profileSettingUpdates[0].data.fcmTokens, ['tok_AAAAAAAAAAAAAAAAAAAA']);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.FCM_SERVER_KEY;
  }
});

test('skipPush / a client-local notificationId / an already-read row: no FCM call at all, and no status write either (unchanged pre-existing gate)', async () => {
  await withNoFcmConfig(async () => {
    for (const row of [
      { ...baseRow(), skipPush: true },
      { ...baseRow(), notificationId: 'n_local_1' },
      { ...baseRow(), isRead: true },
    ]) {
      const { strapi, notificationUpdates } = makeFakeStrapi([
        { id: 10, profileId: 'u_target', fcmTokens: ['tok_AAAAAAAAAAAAAAAAAAAA'] },
      ]);
      await deliverPush(strapi, row);
      assert.equal(notificationUpdates.length, 0, JSON.stringify(row));
    }
  });
});
