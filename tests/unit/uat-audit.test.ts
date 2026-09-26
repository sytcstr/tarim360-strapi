import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { runUatAudit, startUatAuditIfEnabled } from '../../src/utils/uat-audit';

const ALLOWED_QUERY_METHODS = new Set(['count', 'findMany']);

function fakeStrapi(opts: { failOn?: string } = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const rows: Record<string, any[]> = {
    'api::purchase-event.purchase-event': [
      { id: 1, provider: 'google_play', status: 'verified', ownerProfileId: 'u_a', ownerEmail: 'secret-a@example.invalid' },
      { id: 2, provider: 'apple', status: 'rejected', ownerProfileId: 'u_gone', ownerEmail: 'gone@example.invalid' },
      { id: 3, provider: 'google_play', status: 'verified', ownerProfileId: 'u_a', ownerEmail: 'secret-a@example.invalid' },
    ],
    'api::profile-setting.profile-setting': [
      // active premium, no endsAt, backed by a verified event
      { id: 1, profileId: 'u_a', ownerEmail: 'secret-a@example.invalid', roleText: 'Premium Üye', activePremium: { paymentProvider: 'google_play' }, activePremiumSubscription: { paymentProvider: 'google_play' }, purchaseHistory: [{ paymentProvider: 'google_play' }] },
      // active premium with a future endsAt and NO backing at all (orphan profile)
      { id: 2, profileId: 'u_ghost', ownerEmail: 'ghost@example.invalid', roleText: 'Aktif Üye', activePremium: { paymentProvider: 'app_store', endsAt: '2999-01-01T00:00:00Z' }, purchaseHistory: [] },
      // expired object
      { id: 3, profileId: 'u_old', ownerEmail: 'old@example.invalid', roleText: 'Premium Üye', activePremium: { endsAt: '2001-01-01T00:00:00Z' }, purchaseHistory: [] },
    ],
    'api::promo-redemption.promo-redemption': [],
    'plugin::users-permissions.user': [{ id: 1, email: 'secret-a@example.invalid' }],
    'plugin::upload.file': [{ id: 1, size: 12.5 }],
  };
  const strapi: any = {
    log: { info: (m: string) => logs.push(m), error: (m: string) => errors.push(m) },
    entityService: {
      findOne: async (uid: string) => {
        calls.push(`entityService.findOne:${uid}`);
        return { related: [] };
      },
    },
    db: {
      query: (uid: string) =>
        new Proxy(
          {},
          {
            get: (_t, method: string) => {
              if (!ALLOWED_QUERY_METHODS.has(method)) {
                throw new Error(`MUTATION/UNKNOWN API USED: ${method}`);
              }
              return async (arg: any = {}) => {
                calls.push(`${method}:${uid}`);
                if (opts.failOn === uid) throw new Error('boom SECRET-TOKEN-123');
                const list = rows[uid] ?? [];
                if (method === 'count') {
                  if (arg?.where?.payload) return 1;
                  return list.length;
                }
                if (arg?.where?.payload) return [{ id: 1 }];
                const off = Number(arg.offset ?? 0);
                return list.slice(off, off + Number(arg.limit ?? 500));
              };
            },
          },
        ),
    },
  };
  return { strapi, calls, logs, errors };
}

describe('UAT audit', () => {
  const original = process.env.UAT_RESET_DRYRUN;
  afterEach(() => {
    if (original === undefined) delete process.env.UAT_RESET_DRYRUN;
    else process.env.UAT_RESET_DRYRUN = original;
  });

  it('is a complete no-op when UAT_RESET_DRYRUN is unset or not exactly "1"', () => {
    for (const v of [undefined, '', '0', 'true', 'yes', '2']) {
      if (v === undefined) delete process.env.UAT_RESET_DRYRUN;
      else process.env.UAT_RESET_DRYRUN = v;
      const { strapi, calls, logs, errors } = fakeStrapi();
      startUatAuditIfEnabled(strapi);
      assert.equal(calls.length, 0, `no query for env=${String(v)}`);
      assert.equal(logs.length, 0);
      assert.equal(errors.length, 0);
    }
  });

  it('runs read-only (count/findMany/findOne only) and logs aggregate numbers only', async () => {
    const { strapi, calls, logs, errors } = fakeStrapi();
    await runUatAudit(strapi);
    assert.equal(errors.length, 0);
    assert.equal(logs[0], '[UAT AUDIT] BEGIN');
    assert.equal(logs[logs.length - 1], '[UAT AUDIT] END');
    assert.ok(calls.length > 20);
    for (const c of calls) {
      assert.ok(/^(count|findMany):/.test(c) || c.startsWith('entityService.findOne:'), c);
    }
    const text = logs.join('\n');
    assert.match(text, /purchase-event total=3/);
    assert.match(text, /verified\+store payload=1 verified\+no payload=1/);
    assert.match(text, /owner exists=2 orphan=1/);
    assert.match(text, /by provider: google_play=2 apple=1/);
    // profile-setting aggregate
    assert.match(text, /profile-setting total=3 activePremium filled=3 activePremiumSubscription filled=1/);
    assert.match(text, /active\(not expired\)=1 active\(no endsAt -> unlimited\)=1 expired-object=1/);
    assert.match(text, /roleText="Premium Üye"=2 linked-to-app-user=1 orphan=2/);
    assert.match(text, /active-without-verified-purchase-event=1 \(of which backed by promo redemption=0, NO backing at all=1\) backed by verified purchase-event=1/);
    assert.match(text, /entitlement source: google_play=1 app_store=1/);
    assert.equal(logs.filter((l) => l.startsWith('[UAT AUDIT] profile-setting ')).length, 2);
    assert.match(text, /orphan files=1/);
    // privacy: nothing identifying leaks into the log
    for (const banned of ['secret-a', 'gone@', 'ghost@', 'old@', 'u_a', 'u_gone', 'u_ghost', 'u_old', '@example', 'boom']) {
      assert.ok(!text.includes(banned), `log must not contain ${banned}`);
    }
  });

  it('an audit exception never throws and never echoes the error', async () => {
    const { strapi, logs, errors } = fakeStrapi({ failOn: 'api::profile-setting.profile-setting' });
    // count() failures are swallowed to -1; the purchase audit's findMany on profile-setting really throws
    await runUatAudit(strapi);
    assert.deepEqual(errors, ['[UAT AUDIT] FAILED']);
    const all = [...logs, ...errors].join('\n');
    assert.ok(!all.includes('SECRET-TOKEN'), 'exception text must not be logged');
    assert.equal(logs[logs.length - 1], '[UAT AUDIT] END');
  });

  it('the module contains no mutating call (source guard)', () => {
    const src = readFileSync(path.join(__dirname, '../../src/utils/uat-audit.ts'), 'utf8')
      .split('\n')
      .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//') && !l.trim().startsWith('/*'))
      .join('\n');
    assert.ok(!/\.(create|createMany|update|updateMany|delete|deleteMany|upsert|insert|del|truncate)\s*\(/.test(src));
    assert.ok(!/\braw\s*\(/.test(src));
    assert.ok(!/\.transaction\s*\(/.test(src));
  });
});
