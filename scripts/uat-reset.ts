/**
 * UAT RESET -- one-shot, guarded, DRY-RUN-by-default maintenance script.
 *
 * NOT an HTTP endpoint. It boots Strapi headlessly (like the other scripts in
 * this folder) and talks to whatever database the current environment points
 * at. It MUST be removed from the repository once the reset is done.
 *
 * Modes
 *   (default)  DRY-RUN: only COUNT/SELECT queries. Prints, per collection,
 *              total / eligible-to-delete / protected, plus the purchase
 *              ownership audit, the seller-payout audit and the orphan-media
 *              report. Never writes.
 *   --execute  DESTRUCTIVE. Refuses to start unless ALL of these hold:
 *                1. env UAT_RESET_ENABLE=DELETE_APP_USER_DATA
 *                2. --confirm-target=<fingerprint printed by the dry-run>
 *                   (binds the run to the exact database that was reviewed)
 *                3. --confirm-count=<total eligible rows printed by the dry-run>
 *                4. NODE_ENV=production additionally needs --allow-production
 *              purchase-event, seller-payout and (unless --include-hub-content)
 *              hub-content are NEVER in the destructive list.
 *
 * Never printed: emails, names, tokens, receipts, transaction identifiers or
 * any other row content. Only counts.
 *
 * Never touched: admin users, roles/permissions, API tokens, core-store,
 * registration-block, promo-code, processed-product-category, reference data
 * (province, agri-*, hub-category, hub-banner), upload provider config.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nodeCrypto = require('crypto');

type Step = {
  group: string;
  label: string;
  uid: string;
  /** rows eligible for deletion; undefined = every row */
  where?: Record<string, unknown>;
  /** needs an explicit flag before --execute may touch it */
  gate?: 'hub-content';
};

const HUB_USER_OWNED = {
  $or: [
    { ownerEmail: { $notNull: true, $ne: '' } },
    { ownerProfileId: { $notNull: true, $ne: '' } },
  ],
};

// Dependency-safe order: children first, identity last (A..J).
const STEPS: Step[] = [
  { group: 'A', label: 'engagement-interaction', uid: 'api::engagement-interaction.engagement-interaction' },
  { group: 'A', label: 'engagement-view', uid: 'api::engagement-view.engagement-view' },
  { group: 'A', label: 'listing-comment', uid: 'api::listing-comment.listing-comment' },
  { group: 'A', label: 'listing-share', uid: 'api::listing-share.listing-share' },
  { group: 'A', label: 'listing-view', uid: 'api::listing-view.listing-view' },
  { group: 'A', label: 'profile-view', uid: 'api::profile-view.profile-view' },
  { group: 'A', label: 'ad-click', uid: 'api::ad-click.ad-click' },
  { group: 'A', label: 'ad-event', uid: 'api::ad-event.ad-event' },
  { group: 'A', label: 'ai-log', uid: 'api::ai-log.ai-log' },
  { group: 'B', label: 'notification', uid: 'api::notification.notification' },
  { group: 'B', label: 'admin-notification', uid: 'api::admin-notification.admin-notification' },
  { group: 'B', label: 'message', uid: 'api::message.message' },
  { group: 'B', label: 'offer', uid: 'api::offer.offer' },
  { group: 'B', label: 'thread', uid: 'api::thread.thread' },
  { group: 'B', label: 'support-ticket-message', uid: 'api::support-ticket-message.support-ticket-message' },
  { group: 'B', label: 'support-ticket', uid: 'api::support-ticket.support-ticket' },
  { group: 'C', label: 'rocket-activation', uid: 'api::rocket-activation.rocket-activation' },
  { group: 'C', label: 'listing-create-operation', uid: 'api::listing-create-operation.listing-create-operation' },
  { group: 'C', label: 'promo-redemption', uid: 'api::promo-redemption.promo-redemption' },
  { group: 'D', label: 'store-document', uid: 'api::store-document.store-document' },
  { group: 'D', label: 'processed-product', uid: 'api::processed-product.processed-product' },
  { group: 'D', label: 'seller-store', uid: 'api::seller-store.seller-store' },
  { group: 'E', label: 'logistics-offer', uid: 'api::logistics-offer.logistics-offer' },
  { group: 'E', label: 'logistics-load', uid: 'api::logistics-load.logistics-load' },
  { group: 'E', label: 'logistics-vehicle', uid: 'api::logistics-vehicle.logistics-vehicle' },
  { group: 'F', label: 'listing', uid: 'api::listing.listing' },
  { group: 'F', label: 'ad', uid: 'api::ad.ad' },
  { group: 'G', label: 'hub-content (user-owned rows only)', uid: 'api::hub-content.hub-content', where: HUB_USER_OWNED, gate: 'hub-content' },
  { group: 'H', label: 'profile-setting', uid: 'api::profile-setting.profile-setting' },
  { group: 'I', label: 'users-permissions user (APP users; admin users are a different table)', uid: 'plugin::users-permissions.user' },
  { group: 'J', label: 'deleted-account-record', uid: 'api::deleted-account-record.deleted-account-record' },
];

// Counted for the report, never deleted by this script.
const PROTECTED_UIDS: Array<[string, string]> = [
  ['registration-block', 'api::registration-block.registration-block'],
  ['promo-code', 'api::promo-code.promo-code'],
  ['processed-product-category', 'api::processed-product-category.processed-product-category'],
  ['province', 'api::province.province'],
  ['agri-product', 'api::agri-product.agri-product'],
  ['agri-price-observation', 'api::agri-price-observation.agri-price-observation'],
  ['agri-weather-cache', 'api::agri-weather-cache.agri-weather-cache'],
  ['hub-category', 'api::hub-category.hub-category'],
  ['hub-banner', 'api::hub-banner.hub-banner'],
];

const PURCHASE_UID = 'api::purchase-event.purchase-event';
const PAYOUT_UID = 'api::seller-payout.seller-payout';
const HUB_UID = 'api::hub-content.hub-content';
const FILE_UID = 'plugin::upload.file';

const arg = (name: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const count = async (strapi: any, uid: string, where?: Record<string, unknown>): Promise<number> => {
  try {
    return Number(await strapi.db.query(uid).count(where ? { where } : {}));
  } catch (e) {
    return -1; // unreachable / unknown uid
  }
};

const pad = (v: unknown, n: number) => String(v).padEnd(n);
const line = (...cols: Array<[unknown, number]>) =>
  // eslint-disable-next-line no-console
  console.log(cols.map(([v, n]) => pad(v, n)).join(' '));

async function targetFingerprint(strapi: any): Promise<{ text: string; fingerprint: string }> {
  const c = strapi.config.get('database.connection') ?? {};
  const inner = c.connection ?? {};
  const client = String(c.client ?? 'unknown');
  const host = String(inner.host ?? inner.filename ?? (inner.connectionString ? 'connection-string' : 'n/a'));
  const name = String(inner.database ?? '');
  const masked = host.length > 6 ? `${host.slice(0, 3)}***${host.slice(-3)}` : '***';
  const fp = nodeCrypto
    .createHash('sha256')
    .update(`${client}|${host}|${name}|${JSON.stringify(inner.port ?? '')}`)
    .digest('hex')
    .slice(0, 10);
  return { text: `client=${client} host/file=${masked} db=${name ? `${name.slice(0, 2)}***` : '-'}`, fingerprint: fp };
}

async function purchaseAudit(strapi: any): Promise<void> {
  const q = strapi.db.query(PURCHASE_UID);
  const total = await count(strapi, PURCHASE_UID);
  // eslint-disable-next-line no-console
  console.log('\n=== PURCHASE OWNERSHIP AUDIT (counts only; no tokens/receipts/transaction ids printed) ===');
  // eslint-disable-next-line no-console
  console.log(`total purchase-event rows: ${total}`);
  if (total <= 0) return;

  const rows: any[] = await q.findMany({
    select: ['id', 'provider', 'productId', 'status', 'isSubscription', 'ownerProfileId', 'ownerEmail', 'source'],
    populate: {},
    limit: 100000,
  });
  const profileIds = new Set<string>(
    (
      await strapi.db.query('api::profile-setting.profile-setting').findMany({ select: ['profileId'], limit: 100000 })
    )
      .map((r: any) => String(r.profileId ?? ''))
      .filter(Boolean),
  );
  const userEmails = new Set<string>(
    (await strapi.db.query('plugin::users-permissions.user').findMany({ select: ['email'], limit: 100000 }))
      .map((r: any) => String(r.email ?? '').toLowerCase())
      .filter(Boolean),
  );
  // payload presence needs its own query (json column) -- boolean only
  const withPayload = new Set<number>(
    (await q.findMany({ select: ['id'], where: { payload: { $notNull: true } }, limit: 100000 })).map((r: any) => Number(r.id)),
  );

  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const byStatus = new Map<string, number>();
  const byProvider = new Map<string, number>();
  const byProduct = new Map<string, number>();
  let testDomain = 0;
  let verifiedWithPayload = 0;
  let verifiedNoPayload = 0;
  let ownerMissing = 0;
  let orphan = 0;
  for (const r of rows) {
    bump(byStatus, String(r.status ?? 'null'));
    bump(byProvider, String(r.provider ?? 'null'));
    bump(byProduct, `${r.productId ?? 'null'}${r.isSubscription ? ' (sub)' : ''}`);
    const email = String(r.ownerEmail ?? '').toLowerCase();
    if (email.endsWith('@example.invalid')) testDomain++;
    const isVerified = String(r.status ?? '').toLowerCase() === 'verified';
    if (isVerified) (withPayload.has(Number(r.id)) ? verifiedWithPayload++ : verifiedNoPayload++);
    const ownerKnown = (r.ownerProfileId && profileIds.has(String(r.ownerProfileId))) || (email && userEmails.has(email));
    if (!ownerKnown) orphan++;
    if (!r.ownerProfileId && !email) ownerMissing++;
  }
  const dump = (title: string, m: Map<string, number>) => {
    // eslint-disable-next-line no-console
    console.log(`${title}: ${[...m.entries()].map(([k, v]) => `${k}=${v}`).join(' | ') || '-'}`);
  };
  dump('by status', byStatus);
  dump('by provider', byProvider);
  dump('by product', byProduct);
  // eslint-disable-next-line no-console
  console.log(`verified WITH store payload (real-store candidates, would-be PROTECTED): ${verifiedWithPayload}`);
  // eslint-disable-next-line no-console
  console.log(`verified WITHOUT payload (soft-verify signature -> suspected fake, NOT auto-deleted): ${verifiedNoPayload}`);
  // eslint-disable-next-line no-console
  console.log(`owner e-mail on the reserved test domain (@example.invalid): ${testDomain}`);
  // eslint-disable-next-line no-console
  console.log(`owner still exists (user or profile-setting): ${rows.length - orphan} | ORPHAN (owner gone): ${orphan} | no owner fields at all: ${ownerMissing}`);
  // eslint-disable-next-line no-console
  console.log('purchase-event is NEVER in the destructive list; it needs its own explicit approval.');
}

async function payoutAudit(strapi: any): Promise<void> {
  const total = await count(strapi, PAYOUT_UID);
  // eslint-disable-next-line no-console
  console.log('\n=== SELLER-PAYOUT AUDIT ===');
  // eslint-disable-next-line no-console
  console.log(`total seller-payout rows: ${total}`);
  if (total <= 0) return;
  const withSeller = await count(strapi, PAYOUT_UID, { sellerId: { $notNull: true, $ne: '' } });
  const withOrder = await count(strapi, PAYOUT_UID, { orderId: { $notNull: true, $ne: '' } });
  // eslint-disable-next-line no-console
  console.log(`with sellerId: ${withSeller} | with orderId: ${withOrder} (values not printed)`);
  // eslint-disable-next-line no-console
  console.log('seller-payout is NEVER in the destructive list; decision pending.');
}

async function mediaReport(strapi: any): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('\n=== ORPHAN MEDIA REPORT (report only; media is never deleted here) ===');
  const total = await count(strapi, FILE_UID);
  // eslint-disable-next-line no-console
  console.log(`upload file rows: ${total}`);
  if (total <= 0) return;
  let orphanCount = 0;
  let orphanKb = 0;
  let start = 0;
  const pageSize = 200;
  for (;;) {
    const rows: any[] = await strapi.db.query(FILE_UID).findMany({
      select: ['id', 'size'],
      orderBy: { id: 'asc' },
      offset: start,
      limit: pageSize,
    });
    if (!rows.length) break;
    for (const row of rows) {
      const withRelated: any = await strapi.entityService.findOne(FILE_UID, row.id, { populate: ['related'] });
      const related = withRelated?.related;
      if (!Array.isArray(related) || related.length === 0) {
        orphanCount++;
        orphanKb += Number(row.size ?? 0);
      }
    }
    start += rows.length;
    if (rows.length < pageSize) break;
  }
  // eslint-disable-next-line no-console
  console.log(`orphan files (no relation on any content-type): ${orphanCount} | approx size: ${orphanKb.toFixed(1)} KB`);
  // eslint-disable-next-line no-console
  console.log(
    'note: files that belong to rows this reset will delete are still "related" now and will become orphans afterwards; re-run this report after the cleanup.',
  );
}

async function main(): Promise<void> {
  const execute = flag('execute');
  const includeHub = flag('include-hub-content');

  if (execute) {
    // gates that do not need the database
    if (process.env.UAT_RESET_ENABLE !== 'DELETE_APP_USER_DATA') {
      throw new Error('REFUSED: env UAT_RESET_ENABLE=DELETE_APP_USER_DATA is not set.');
    }
    if (process.env.NODE_ENV === 'production' && !flag('allow-production')) {
      throw new Error('REFUSED: NODE_ENV=production requires --allow-production.');
    }
  }

  const compiled = await compileStrapi();
  const strapi = await createStrapi(compiled).load();
  try {
    const target = await targetFingerprint(strapi);
    // eslint-disable-next-line no-console
    console.log(`MODE: ${execute ? 'EXECUTE (destructive)' : 'DRY-RUN (read-only)'}`);
    // eslint-disable-next-line no-console
    console.log(`TARGET DATABASE: ${target.text}`);
    // eslint-disable-next-line no-console
    console.log(`TARGET FINGERPRINT: ${target.fingerprint}`);
    // eslint-disable-next-line no-console
    console.log(`NODE_ENV: ${process.env.NODE_ENV ?? '(unset)'}\n`);

    line(['GRP', 4], ['COLLECTION', 44], ['TOTAL', 8], ['DELETE', 8], ['KEEP', 8], ['NOTE', 30]);
    let eligibleTotal = 0;
    const plan: Array<{ step: Step; eligible: number }> = [];
    for (const step of STEPS) {
      const total = await count(strapi, step.uid);
      const eligible = total < 0 ? 0 : step.where ? await count(strapi, step.uid, step.where) : total;
      const gated = step.gate === 'hub-content' && !includeHub;
      const willDelete = gated ? 0 : eligible;
      eligibleTotal += willDelete;
      plan.push({ step, eligible: willDelete });
      line(
        [step.group, 4],
        [step.label, 44],
        [total < 0 ? 'n/a' : total, 8],
        [willDelete, 8],
        [total < 0 ? 'n/a' : total - willDelete, 8],
        [gated ? (eligible > 0 ? `GATED: ${eligible} eligible, needs --include-hub-content` : 'gated (none eligible)') : '', 30],
      );
    }
    // eslint-disable-next-line no-console
    console.log(`\nTOTAL rows the destructive mode would delete: ${eligibleTotal}`);

    // eslint-disable-next-line no-console
    console.log('\n=== PROTECTED (counted, never touched) ===');
    for (const [label, uid] of PROTECTED_UIDS) {
      const n = await count(strapi, uid);
      line([label, 34], [n < 0 ? 'n/a' : n, 8]);
    }
    line(['purchase-event (special rule)', 34], [await count(strapi, PURCHASE_UID), 8]);
    line(['seller-payout (special rule)', 34], [await count(strapi, PAYOUT_UID), 8]);
    line(['hub-content (all rows)', 34], [await count(strapi, HUB_UID), 8]);

    await purchaseAudit(strapi);
    await payoutAudit(strapi);
    await mediaReport(strapi);

    if (!execute) {
      // eslint-disable-next-line no-console
      console.log('\nDRY-RUN complete: nothing was written.');
      return;
    }

    if (arg('confirm-target') !== target.fingerprint) {
      throw new Error('REFUSED: --confirm-target does not match the fingerprint of the connected database.');
    }
    if (arg('confirm-count') !== String(eligibleTotal)) {
      throw new Error(`REFUSED: --confirm-count must equal ${eligibleTotal}.`);
    }

    // eslint-disable-next-line no-console
    console.log('\nCONFIRMED. Deleting in dependency order...');
    for (const { step, eligible } of plan) {
      if (eligible <= 0) continue;
      let removed = 0;
      for (;;) {
        const rows: any[] = await strapi.db.query(step.uid).findMany({
          select: ['id'],
          ...(step.where ? { where: step.where } : {}),
          limit: 200,
        });
        if (!rows.length) break;
        const ids = rows.map((r) => r.id);
        await strapi.db.query(step.uid).deleteMany({ where: { id: { $in: ids } } });
        removed += ids.length;
      }
      // eslint-disable-next-line no-console
      console.log(`  [${step.group}] ${step.label}: deleted ${removed}`);
    }
    // eslint-disable-next-line no-console
    console.log('EXECUTE complete. Re-run without --execute to verify the remaining counts.');
  } finally {
    await strapi.destroy();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(String(error?.message ?? error));
  process.exitCode = 1;
});

export {};
