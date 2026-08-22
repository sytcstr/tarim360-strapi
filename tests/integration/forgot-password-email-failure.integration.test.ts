/**
 * FINAL_R1_TARGETED_RELEASE_FIX_REPORT.md R1.5 (FINAL-BUG-005, HIGH):
 * requestPasswordReset used to persist the new temporary password to the
 * user record BEFORE attempting to send it by email -- an SMTP failure
 * left the user's real password silently overwritten while they saw only
 * a generic "gonderilemedi" failure, with no way to recover the temp
 * password they were never actually sent. The fix reorders this: send
 * first, only persist the new password once delivery has genuinely
 * succeeded.
 *
 * This suite stubs the real Strapi `email` plugin's `send` method
 * directly on the booted instance (rather than relying on ambient SMTP
 * availability, which is unconfigured in this throwaway test boot and
 * would make the "success" case untestable) so both outcomes are
 * exercised deterministically.
 *
 * Run: npm run test:integration (real Strapi boot against a throwaway
 * SQLite file — see before() below).
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const TEST_DB_FILE_RELATIVE = 'tests/integration/.tmp-forgot-password-email-failure-test.db';
const TEST_DB_FILE = path.join(__dirname, '.tmp-forgot-password-email-failure-test.db');
const PORT = 14180;
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

async function registerUser(email: string, password: string) {
  const res = await fetch(`${BASE_URL}/auth/local/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: email, email, password }),
  });
  return res.json();
}

async function login(identifier: string, password: string) {
  const res = await fetch(`${BASE_URL}/auth/local`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function requestPasswordReset(identifier: string) {
  const res = await fetch(`${BASE_URL}/auth/request-password-reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ identifier }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function withStubbedEmailSend<T>(
  impl: (args: { to: string; subject: string; text: string; html: string }) => Promise<void>,
  fn: () => Promise<T>,
): Promise<T> {
  const emailService = strapiInstance.plugin('email').service('email');
  const original = emailService.send;
  emailService.send = impl;
  return fn().finally(() => {
    emailService.send = original;
  });
}

test('requestPasswordReset: email send failure leaves the real password completely unchanged', async () => {
  const email = `r15-fail-${randomUUID()}@test.local`;
  const originalPassword = 'Passw0rd!Original1';
  await registerUser(email, originalPassword);

  const result = await withStubbedEmailSend(
    async () => {
      throw new Error('SMTP baglanti hatasi (simulated outage)');
    },
    () => requestPasswordReset(email),
  );

  assert.equal(result.status, 400, 'a send failure must be reported as a failure, not a fake success');
  assert.notEqual(result.body?.ok, true);

  const stillWorks = await login(email, originalPassword);
  assert.equal(
    stillWorks.status,
    200,
    'the ORIGINAL password must still work after a failed reset -- it must never have been changed',
  );
  assert.ok(stillWorks.body?.jwt, 'a successful login must return a jwt');
});

test('requestPasswordReset: a successful email send changes the password to the delivered temporary password', async () => {
  const email = `r15-success-${randomUUID()}@test.local`;
  const originalPassword = 'Passw0rd!Original2';
  await registerUser(email, originalPassword);

  let capturedText = '';
  const result = await withStubbedEmailSend(
    async (args) => {
      capturedText = args.text;
    },
    () => requestPasswordReset(email),
  );

  assert.equal(result.status, 200);
  assert.equal(result.body?.ok, true);

  const match = capturedText.match(/Gecici sifreniz:\s*(\S+)/);
  assert.ok(match, `expected the stubbed email body to contain the temp password, got: ${capturedText}`);
  const tempPassword = match![1];

  const oldPasswordLogin = await login(email, originalPassword);
  assert.notEqual(
    oldPasswordLogin.status,
    200,
    'the OLD password must no longer work once a successful reset actually changed it',
  );

  const tempPasswordLogin = await login(email, tempPassword);
  assert.equal(tempPasswordLogin.status, 200, 'the newly delivered temporary password must work');
  assert.ok(tempPasswordLogin.body?.jwt);
});

test('requestPasswordReset: unknown email still returns ok:true (enumeration protection unaffected by this fix)', async () => {
  const result = await requestPasswordReset(`r15-unknown-${randomUUID()}@test.local`);
  assert.equal(result.status, 200);
  assert.equal(result.body?.ok, true);
});
