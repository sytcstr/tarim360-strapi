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

const chunk = <T>(arr: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

const parseDate = (v: unknown): Date | null => {
  const raw = String(v ?? '').trim();
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

const asObject = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** Normalises a free-form provider string into a fixed, non-identifying bucket. */
const sourceBucket = (raw: unknown): string => {
  const s = String(raw ?? '').toLowerCase();
  if (!s) return 'unknown';
  if (s.includes('promo')) return 'promo_code';
  if (s.includes('google') || s.includes('play')) return 'google_play';
  if (s.includes('app') || s.includes('apple') || s.includes('ios')) return 'app_store';
  return 'unknown';
};

/** Same activity rule as the backend's isPremiumActiveFromProfile. */
const premiumOf = (row: any): Record<string, unknown> | null =>
  asObject(row?.activePremium) ?? asObject(row?.activePremiumSubscription);

/** profile-setting aggregate: counts only, no value that identifies anyone. */
async function profileSettingAudit(strapi: any, log: (line: string) => void): Promise<void> {
  const PROFILE_UID = 'api::profile-setting.profile-setting';
  const total = await countOf(strapi, PROFILE_UID);
  if (total <= 0) {
    log(`profile-setting total=${total}`);
    return;
  }
  const rows = await readAll(strapi, PROFILE_UID, [
    'id',
    'profileId',
    'ownerEmail',
    'roleText',
    'activePremium',
    'activePremiumSubscription',
    'purchaseHistory',
  ]);
  const users = await readAll(strapi, USER_UID, ['id', 'email']);
  const derived = new Set<string>();
  const emails = new Set<string>();
  for (const u of users) {
    const e = String(u.email ?? '').toLowerCase();
    if (!e) continue;
    emails.add(e);
    derived.add(`u_${e.replace(/[^a-z0-9]/g, '_')}`);
  }
  const verifiedOwners = new Set<string>(
    (await readAll(strapi, PURCHASE_UID, ['id', 'ownerProfileId', 'status']))
      .filter((r) => String(r.status ?? '').toLowerCase() === 'verified')
      .map((r) => String(r.ownerProfileId ?? ''))
      .filter(Boolean),
  );
  const promoOwners = new Set<string>(
    (await readAll(strapi, 'api::promo-redemption.promo-redemption', ['id', 'ownerProfileId']))
      .map((r) => String(r.ownerProfileId ?? ''))
      .filter(Boolean),
  );

  const now = Date.now();
  let apFilled = 0;
  let apsFilled = 0;
  let activeNotExpired = 0;
  let activeNoEndsAt = 0;
  let expiredWithObject = 0;
  let historyFilled = 0;
  let rolePremium = 0;
  let linked = 0;
  let orphanRows = 0;
  let activeNoVerifiedEvent = 0;
  let activeBackedVerified = 0;
  let activeBackedPromo = 0;
  let activeNoBacking = 0;
  const providers = new Map<string, number>();
  const sources = new Map<string, number>();

  for (const r of rows) {
    if (asObject(r.activePremium)) apFilled++;
    if (asObject(r.activePremiumSubscription)) apsFilled++;
    const hist = Array.isArray(r.purchaseHistory) ? r.purchaseHistory : [];
    if (hist.length > 0) historyFilled++;
    if (String(r.roleText ?? '').trim().toLowerCase() === 'premium üye') rolePremium++;
    const pid = String(r.profileId ?? '');
    const em = String(r.ownerEmail ?? '').toLowerCase();
    if ((pid && derived.has(pid)) || (em && emails.has(em))) linked++;
    else orphanRows++;

    const prem = premiumOf(r);
    if (!prem) continue;
    const ends = parseDate(prem.endsAt);
    const active = !ends || ends.getTime() > now;
    if (!active) {
      expiredWithObject++;
      continue;
    }
    if (ends) activeNotExpired++;
    else activeNoEndsAt++;
    tally(providers, prem.paymentProvider ?? 'null');
    const latest = asObject(hist[0]);
    tally(sources, sourceBucket(prem.paymentProvider ?? latest?.paymentProvider));
    const hasVerified = !!pid && verifiedOwners.has(pid);
    const hasPromo = !!pid && promoOwners.has(pid);
    if (!hasVerified) activeNoVerifiedEvent++;
    if (hasVerified) activeBackedVerified++;
    else if (hasPromo) activeBackedPromo++;
    else activeNoBacking++;
  }

  log(
    `profile-setting total=${total} activePremium filled=${apFilled} activePremiumSubscription filled=${apsFilled} ` +
      `active(not expired)=${activeNotExpired} active(no endsAt -> unlimited)=${activeNoEndsAt} expired-object=${expiredWithObject} ` +
      `purchaseHistory filled=${historyFilled} roleText="Premium Üye"=${rolePremium} linked-to-app-user=${linked} orphan=${orphanRows}`,
  );
  log(
    `profile-setting premium backing: active-without-verified-purchase-event=${activeNoVerifiedEvent} ` +
      `(of which backed by promo redemption=${activeBackedPromo}, NO backing at all=${activeNoBacking}) ` +
      `backed by verified purchase-event=${activeBackedVerified} | paymentProvider: ${fmt(providers)} | entitlement source: ${fmt(sources)}`,
  );
}

export async function runUatAudit(strapi: { db: any; entityService: any; log: Logger }): Promise<void> {
  const log = (line: string) => strapi.log.info(`[UAT AUDIT] ${line}`);
  log('BEGIN');
  try {
    // user/test data: a few long lines instead of one line per collection
    const counts: string[] = [];
    for (const [label, uid] of USER_DATA) counts.push(`${label}=${await countOf(strapi, uid)}`);
    chunk(counts, 8).forEach((c, i) => log(`user-data counts ${i + 1}: ${c.join(' ')}`));

    await profileSettingAudit(strapi, log);

    // ---- purchase-event ----
    const purchaseTotal = await countOf(strapi, PURCHASE_UID);
    if (purchaseTotal > 0) {
      const rows = await readAll(strapi, PURCHASE_UID, [
        'id',
        'provider',
        'status',
        'ownerProfileId',
        'ownerEmail',
      ]);
      const payloadIds = new Set<number>();
      for (let offset = 0; ; offset += PAGE) {
        const page: any[] = await strapi.db.query(PURCHASE_UID).findMany({
          select: ['id'],
          where: { payload: { $notNull: true } },
          orderBy: { id: 'asc' },
          offset,
          limit: PAGE,
        });
        if (!page.length) break;
        for (const r of page) payloadIds.add(Number(r.id));
        if (page.length < PAGE) break;
      }
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
      log(
        `purchase-event total=${purchaseTotal} by status: ${fmt(byStatus)} | by provider: ${fmt(byProvider)} | ` +
          `verified+store payload=${verifiedWithPayload} verified+no payload=${verifiedNoPayload} | ` +
          `owner exists=${ownerExists} orphan=${orphan}`,
      );
    } else {
      log(`purchase-event total=${purchaseTotal}`);
    }

    // ---- hub-content + seller-payout ----
    const hubTotal = await countOf(strapi, HUB_UID);
    const hubUser = await countOf(strapi, HUB_UID, {
      $or: [
        { ownerEmail: { $notNull: true, $ne: '' } },
        { ownerProfileId: { $notNull: true, $ne: '' } },
      ],
    });
    log(
      `hub-content total=${hubTotal} user-owned=${hubUser} editorial/config kept=${hubTotal >= 0 && hubUser >= 0 ? hubTotal - hubUser : -1} | ` +
        `seller-payout total=${await countOf(strapi, PAYOUT_UID)} sellerId set=${await countOf(strapi, PAYOUT_UID, { sellerId: { $notNull: true, $ne: '' } })} orderId set=${await countOf(strapi, PAYOUT_UID, { orderId: { $notNull: true, $ne: '' } })}`,
    );

    // ---- uploads ----
    const fileTotal = await countOf(strapi, FILE_UID);
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
        `uploads total=${fileTotal} scanned=${scanned}${scanned < fileTotal ? ' (capped)' : ''} orphan files=${orphanFiles} approx orphan size=${orphanKb.toFixed(1)}KB`,
      );
    } else {
      log(`uploads total=${fileTotal}`);
    }

    // ---- protected ----
    const prot: string[] = [];
    for (const [label, uid] of PROTECTED) prot.push(`${label}=${await countOf(strapi, uid)}`);
    log(`protected config/reference counts (never touched): ${prot.join(' ')}`);
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
