import type { Core } from '@strapi/strapi';

/**
 * UAT production audit -- READ-ONLY, env-gated, aggregate counts only.
 *
 * Runs only when the environment variable UAT_RESET_DRYRUN is exactly "1".
 * Otherwise `startUatAuditIfEnabled` returns immediately without running a
 * query or printing a line. This module must never call a mutating API:
 * only `count`, `findMany` and `findOne` are used (enforced by
 * tests/unit/uat-audit.test.ts, which fails on any create/update/delete
 * style call in this file and on a fake database that rejects them).
 *
 * The log lines carry numbers only -- never an e-mail, name, phone, owner or
 * user id, purchase token, receipt, transaction id, payload or secret.
 *
 * Remove this file (and its single call in src/index.ts) once the reset is
 * finished.
 */

const ENV_KEY = 'UAT_RESET_DRYRUN';
const PAGE = 500;
const MAX_UPLOAD_SCAN = 5000;

type Logger = { info: (m: string) => void; error: (m: string) => void };

const USER_UID = 'plugin::users-permissions.user';
const FILE_UID = 'plugin::upload.file';

/** [label, uid] -- user/test data that the reset would target. */
const USER_DATA: Array<[string, string]> = [
  ['users-permissions app users', USER_UID],
  ['profile-setting', 'api::profile-setting.profile-setting'],
  ['listing', 'api::listing.listing'],
  ['listing-comment', 'api::listing-comment.listing-comment'],
  ['listing-share', 'api::listing-share.listing-share'],
  ['listing-view', 'api::listing-view.listing-view'],
  ['listing-create-operation', 'api::listing-create-operation.listing-create-operation'],
  ['processed-product', 'api::processed-product.processed-product'],
  ['seller-store', 'api::seller-store.seller-store'],
  ['store-document', 'api::store-document.store-document'],
  ['logistics-load', 'api::logistics-load.logistics-load'],
  ['logistics-vehicle', 'api::logistics-vehicle.logistics-vehicle'],
  ['logistics-offer', 'api::logistics-offer.logistics-offer'],
  ['message', 'api::message.message'],
  ['thread', 'api::thread.thread'],
  ['offer', 'api::offer.offer'],
  ['notification', 'api::notification.notification'],
  ['admin-notification', 'api::admin-notification.admin-notification'],
  ['support-ticket', 'api::support-ticket.support-ticket'],
  ['support-ticket-message', 'api::support-ticket-message.support-ticket-message'],
  ['engagement-interaction', 'api::engagement-interaction.engagement-interaction'],
  ['engagement-view', 'api::engagement-view.engagement-view'],
  ['profile-view', 'api::profile-view.profile-view'],
  ['ad', 'api::ad.ad'],
  ['ad-click', 'api::ad-click.ad-click'],
  ['ad-event', 'api::ad-event.ad-event'],
  ['ai-log', 'api::ai-log.ai-log'],
  ['rocket-activation', 'api::rocket-activation.rocket-activation'],
  ['promo-redemption', 'api::promo-redemption.promo-redemption'],
  ['deleted-account-record', 'api::deleted-account-record.deleted-account-record'],
];

/** Config / reference records: counted only. */
const PROTECTED: Array<[string, string]> = [
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

const countOf = async (strapi: any, uid: string, where?: Record<string, unknown>): Promise<number> => {
  try {
    return Number(await strapi.db.query(uid).count(where ? { where } : {}));
  } catch {
    return -1;
  }
};

const readAll = async (strapi: any, uid: string, select: string[]): Promise<any[]> => {
  const out: any[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const rows: any[] = await strapi.db.query(uid).findMany({
      select,
      orderBy: { id: 'asc' },
      offset,
      limit: PAGE,
    });
    if (!Array.isArray(rows) || rows.length === 0) break;
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
};

const tally = (m: Map<string, number>, key: unknown) => {
  const k = String(key ?? 'null').slice(0, 40);
  m.set(k, (m.get(k) ?? 0) + 1);
};
const fmt = (m: Map<string, number>) =>
  [...m.entries()].map(([k, v]) => `${k}=${v}`).join(' ') || '-';

export async function runUatAudit(strapi: { db: any; entityService: any; log: Logger }): Promise<void> {
  const log = (line: string) => strapi.log.info(`[UAT AUDIT] ${line}`);
  log('BEGIN');
  try {
    log('-- user/test data (rows the reset would target) --');
    for (const [label, uid] of USER_DATA) {
      log(`${label}: ${await countOf(strapi, uid)}`);
    }

    // ---- purchase-event ----
    const purchaseTotal = await countOf(strapi, PURCHASE_UID);
    log(`-- purchase-event -- total=${purchaseTotal}`);
    if (purchaseTotal > 0) {
      const rows = await readAll(strapi, PURCHASE_UID, [
        'id',
        'provider',
        'status',
        'ownerProfileId',
        'ownerEmail',
      ]);
      const payloadIds = new Set<number>(
        (
          await (async () => {
            const acc: any[] = [];
            for (let offset = 0; ; offset += PAGE) {
              const page: any[] = await strapi.db.query(PURCHASE_UID).findMany({
                select: ['id'],
                where: { payload: { $notNull: true } },
                orderBy: { id: 'asc' },
                offset,
                limit: PAGE,
              });
              if (!page.length) break;
              acc.push(...page);
              if (page.length < PAGE) break;
            }
            return acc;
          })()
        ).map((r) => Number(r.id)),
      );
      const profileIds = new Set<string>(
        (await readAll(strapi, 'api::profile-setting.profile-setting', ['id', 'profileId']))
          .map((r) => String(r.profileId ?? ''))
          .filter(Boolean),
      );
      const userEmails = new Set<string>(
        (await readAll(strapi, USER_UID, ['id', 'email']))
          .map((r) => String(r.email ?? '').toLowerCase())
          .filter(Boolean),
      );
      const byStatus = new Map<string, number>();
      const byProvider = new Map<string, number>();
      let verifiedWithPayload = 0;
      let verifiedNoPayload = 0;
      let ownerExists = 0;
      let orphan = 0;
      for (const r of rows) {
        tally(byStatus, r.status);
        tally(byProvider, r.provider);
        if (String(r.status ?? '').toLowerCase() === 'verified') {
          if (payloadIds.has(Number(r.id))) verifiedWithPayload++;
          else verifiedNoPayload++;
        }
        const email = String(r.ownerEmail ?? '').toLowerCase();
        const known =
          (r.ownerProfileId && profileIds.has(String(r.ownerProfileId))) ||
          (email && userEmails.has(email));
        if (known) ownerExists++;
        else orphan++;
      }
      log(`purchase-event by status: ${fmt(byStatus)}`);
      log(`purchase-event by provider: ${fmt(byProvider)}`);
      log(`purchase-event verified+store payload=${verifiedWithPayload} verified+no payload=${verifiedNoPayload}`);
      log(`purchase-event owner exists=${ownerExists} orphan=${orphan}`);
    }

    // ---- hub-content ----
    const hubTotal = await countOf(strapi, HUB_UID);
    const hubUser = await countOf(strapi, HUB_UID, {
      $or: [
        { ownerEmail: { $notNull: true, $ne: '' } },
        { ownerProfileId: { $notNull: true, $ne: '' } },
      ],
    });
    log(`-- hub-content -- total=${hubTotal} user-owned=${hubUser} editorial/config kept=${hubTotal >= 0 && hubUser >= 0 ? hubTotal - hubUser : -1}`);

    // ---- seller-payout ----
    log(
      `-- seller-payout -- total=${await countOf(strapi, PAYOUT_UID)} sellerId set=${await countOf(strapi, PAYOUT_UID, { sellerId: { $notNull: true, $ne: '' } })} orderId set=${await countOf(strapi, PAYOUT_UID, { orderId: { $notNull: true, $ne: '' } })}`,
    );

    // ---- uploads ----
    const fileTotal = await countOf(strapi, FILE_UID);
    log(`-- uploads -- total=${fileTotal}`);
    if (fileTotal > 0) {
      let scanned = 0;
      let orphanFiles = 0;
      let orphanKb = 0;
      for (let offset = 0; scanned < MAX_UPLOAD_SCAN; offset += PAGE) {
        const rows: any[] = await strapi.db.query(FILE_UID).findMany({
          select: ['id', 'size'],
          orderBy: { id: 'asc' },
          offset,
          limit: PAGE,
        });
        if (!rows.length) break;
        for (const row of rows) {
          scanned++;
          const withRelated = await strapi.entityService.findOne(FILE_UID, row.id, {
            populate: ['related'],
          });
          const related = withRelated?.related;
          if (!Array.isArray(related) || related.length === 0) {
            orphanFiles++;
            orphanKb += Number(row.size ?? 0);
          }
        }
        if (rows.length < PAGE) break;
      }
      log(
        `uploads scanned=${scanned}${scanned < fileTotal ? ' (capped)' : ''} orphan files=${orphanFiles} approx orphan size=${orphanKb.toFixed(1)}KB`,
      );
    }

    // ---- protected ----
    log('-- protected config/reference records (count only, never touched) --');
    for (const [label, uid] of PROTECTED) {
      log(`${label}: ${await countOf(strapi, uid)}`);
    }
  } catch {
    // Deliberately no exception text/body: it could echo row data.
    strapi.log.error('[UAT AUDIT] FAILED');
  }
  log('END');
}

/**
 * Single call point for src/index.ts. Without UAT_RESET_DRYRUN=1 this does
 * nothing at all. When enabled it is detached from the boot sequence
 * (deferred, never awaited) so a slow or failing audit cannot delay or break
 * startup.
 */
export function startUatAuditIfEnabled(strapi: Core.Strapi | any): void {
  if (process.env[ENV_KEY] !== '1') return;
  try {
    const timer = setTimeout(() => {
      void runUatAudit(strapi).catch(() => {
        try {
          strapi.log.error('[UAT AUDIT] FAILED');
        } catch {
          /* nothing else to do */
        }
      });
    }, 15000);
    if (typeof (timer as any)?.unref === 'function') (timer as any).unref();
  } catch {
    /* never affect startup */
  }
}
