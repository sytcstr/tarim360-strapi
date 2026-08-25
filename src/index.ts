import type { Core } from '@strapi/strapi';
import { syncOwnerPremiumFlags } from './utils/premium-sync';
import { deliverPush as deliverNotificationPush } from './api/notification/content-types/notification/lifecycles';
import {
  cleanupOwnerEmbeddedHubContent,
  normalizeCleanupEmail,
  ownerIdFromCleanupEmail,
} from './utils/account-cleanup';
import { runOfferIdDedupeOnce } from './utils/offer-id-dedupe';
import { hasUniqueIndex } from './utils/engagement-index-support';
import { runListingNoBackfillOnce } from './utils/listing-number-backfill';

/**
 * Faz B-V: reliable, idempotent composite-unique-index creation for the
 * Engagement API's interaction/view tables. This runs here — inside
 * `bootstrap()`, which Strapi's own boot sequence guarantees executes
 * AFTER `db.schema.sync()` has created/altered every content-type table
 * for this boot (verified: `@strapi/core`'s `Strapi.js#bootstrap()` calls
 * `db.schema.sync()` then, at the very end, `runUserLifecycles(BOOTSTRAP)`,
 * which is what invokes this function) — rather than in
 * `database/migrations/`, because Strapi runs pending migrations BEFORE
 * schema sync (`@strapi/database`'s `schema/index.js#sync()`), so a
 * brand-new content-type's table is guaranteed to not exist yet the
 * first time a migration shipped in the same deploy would run. This
 * function has no such problem: by the time it runs, the table always
 * exists. It is idempotent (checks index existence via
 * `hasUniqueIndex`/`dialect.schemaInspector` first — dialect-portable,
 * see src/utils/engagement-index-support.ts; a prior version used a
 * hand-written SQLite-only PRAGMA query here, which crashed Strapi
 * Cloud's boot on production's non-SQLite dialect — see
 * ENGAGEMENT_INDEX_PORTABILITY_PRODUCTION_FIX_REPORT.md) and safe to run
 * on every single boot. Unlike the migration files
 * (database/migrations/*add-engagement-*-unique-index.ts, kept as a
 * secondary/redundant safety net now that their own export-shape bug is
 * fixed), a genuine failure here is NOT swallowed — it rethrows, so a
 * broken index creation fails the boot loudly instead of silently
 * leaving the engagement system without its concurrency guarantee.
 */
export const ENGAGEMENT_UNIQUE_INDEXES: Array<{ table: string; name: string; columns: string[] }> = [
  {
    table: 'engagement_interactions',
    name: 'engagement_interactions_actor_target_kind_unique',
    columns: ['actor_key', 'target_type', 'target_id', 'kind'],
  },
  {
    table: 'engagement_views',
    name: 'engagement_views_actor_target_unique',
    columns: ['actor_key', 'target_type', 'target_id'],
  },
];

export const ensureEngagementUniqueIndexes = async (strapi: Core.Strapi) => {
  const knex = (strapi.db as any).connection;
  for (const { table, name, columns } of ENGAGEMENT_UNIQUE_INDEXES) {
    try {
      const hasTable = await knex.schema.hasTable(table);
      if (!hasTable) {
        // Should not happen this late in boot; if it does, something
        // more fundamental is wrong — surface it, don't hide it.
        throw new Error(`Table "${table}" does not exist after schema sync.`);
      }
      if (await hasUniqueIndex(strapi.db as any, table, name)) {
        strapi.log.info(`[engagement bootstrap] ${name} already present on ${table}.`);
        continue;
      }
      await knex.schema.alterTable(table, (t: any) => {
        t.unique(columns, { indexName: name });
      });
      strapi.log.info(`[engagement bootstrap] Created unique index ${name} on ${table}.`);
    } catch (e) {
      strapi.log.error(
        `[engagement bootstrap] FAILED to ensure unique index ${name} on ${table}: ${e}`,
      );
      throw e;
    }
  }
};

/**
 * LISTING_L3_LISTING_TYPE_AND_PUBLIC_NUMBER_REPORT.md L3.5/L3.6: same
 * idempotent, every-boot pattern as ensureEngagementUniqueIndexes, for the
 * listing content-type's `listing_no` column. MUST run after
 * runListingNoBackfillOnce (see the bootstrap() call order below) --
 * creating this index before the backfill would fail outright against any
 * pre-existing null/duplicate listingNo values from the old
 * client-derived numbering scheme.
 *
 * This is a PARTIAL index (`WHERE published_at IS NOT NULL`), not a plain
 * column-wide unique index -- `listing` has draftAndPublish:true, so every
 * real listing is TWO physical rows (a draft, published_at:null, and the
 * published row) that must carry the IDENTICAL listingNo (confirmed live
 * while writing this fix: a normal PUT edit re-syncs the published row's
 * content from the draft, so a listingNo that only ever existed on the
 * published side gets silently wiped back to null by the very next
 * unrelated edit -- both rows must have it). A plain unique index would
 * reject a row's own draft/published pair for sharing that number; scoping
 * to published-only rows means only genuinely different listings compete
 * for uniqueness, while a row's own draft sibling (excluded from the
 * index because its published_at is null) never conflicts with it.
 *
 * `WHERE`-scoped partial unique indexes are supported identically by both
 * dialects this project actually runs (SQLite for tests/dev, PostgreSQL on
 * Strapi Cloud production -- confirmed via config/database.ts's
 * connections map) via raw `CREATE UNIQUE INDEX ... WHERE ...`, which is
 * why this uses knex.raw rather than the portable
 * dialect.schemaInspector/alterTable API `ensureEngagementUniqueIndexes`
 * uses (that API has no partial-index option). If this project's
 * DATABASE_CLIENT is ever switched to mysql (also listed in
 * config/database.ts but not evidenced as actually deployed anywhere),
 * this specific statement would need revisiting -- older MySQL has no
 * native partial/filtered unique index support.
 */
export const ensureListingNoUniqueIndex = async (strapi: Core.Strapi) => {
  const table = 'listings';
  const name = 'listings_listing_no_unique';
  const knex = (strapi.db as any).connection;
  try {
    const hasTable = await knex.schema.hasTable(table);
    if (!hasTable) {
      throw new Error(`Table "${table}" does not exist after schema sync.`);
    }
    if (await hasUniqueIndex(strapi.db as any, table, name)) {
      strapi.log.info(`[listing bootstrap] ${name} already present on ${table}.`);
      return;
    }
    await knex.raw(
      `CREATE UNIQUE INDEX ${name} ON ${table} (listing_no) WHERE published_at IS NOT NULL`,
    );
    strapi.log.info(`[listing bootstrap] Created unique index ${name} on ${table}.`);
  } catch (e) {
    strapi.log.error(
      `[listing bootstrap] FAILED to ensure unique index ${name} on ${table}: ${e}`,
    );
    throw e;
  }
};

type PermissionLeaf = {
  enabled: boolean;
  policy?: string;
};

type PermissionsTree = Record<
  string,
  {
    controllers: Record<string, Record<string, PermissionLeaf>>;
  }
>;

const enableAction = (permissions: PermissionsTree, actionId: string) => {
  const parts = actionId.split('.');
  if (parts.length < 3) return;
  const [typeName, controllerName, actionName] = parts;
  const node = permissions[typeName]?.controllers?.[controllerName]?.[actionName];
  if (!node) return;
  permissions[typeName].controllers[controllerName][actionName] = {
    ...node,
    enabled: true,
  };
};

const enableMany = (permissions: PermissionsTree, actionIds: string[]) => {
  for (const id of actionIds) {
    enableAction(permissions, id);
  }
};

const publicActions: string[] = [
  // Auth basics
  'plugin::users-permissions.auth.callback',
  'plugin::users-permissions.auth.register',
  'plugin::users-permissions.auth.forgotPassword',
  'plugin::users-permissions.auth.resetPassword',
  'plugin::users-permissions.auth.refresh',

  // Public reads
  'api::listing.listing.find',
  'api::listing.listing.findOne',
  'api::ad.ad.find',
  'api::ad.ad.findOne',
  'api::hub-content.hub-content.find',
  'api::hub-content.hub-content.findOne',
  'api::hub-category.hub-category.find',
  'api::hub-category.hub-category.findOne',
  'api::hub-banner.hub-banner.find',
  'api::hub-banner.hub-banner.findOne',
  'api::agri-product.agri-product.find',
  'api::agri-product.agri-product.findOne',
  'api::province.province.find',
  'api::province.province.findOne',
  'api::agri-price-observation.agri-price-observation.find',
  'api::agri-price-observation.agri-price-observation.findOne',
  'api::agri-weather-cache.agri-weather-cache.find',
  'api::agri-weather-cache.agri-weather-cache.findOne',

  // Processed products public reads
  'api::processed-products.processed-products.publicList',
  'api::processed-product.processed-product.publicList',
  'api::processed-seller-stores.processed-seller-stores.publicList',

  // Logistics public reads
  'api::logistics-load.logistics-load.find',
  'api::logistics-load.logistics-load.findOne',
  'api::logistics-load.logistics-load.nearby',
  'api::logistics-vehicle.logistics-vehicle.find',
  'api::logistics-vehicle.logistics-vehicle.findOne',
  'api::logistics-vehicle.logistics-vehicle.nearby',
  'api::logistics-offer.logistics-offer.find',
  'api::logistics-offer.logistics-offer.findOne',
  'api::logistics-offer.logistics-offer.byLoad',
  // Custom auth-flow endpoints
  'api::auth-flow.auth-flow.premiumOwners',
  'api::auth-flow.auth-flow.checkRegistration',
  'api::auth-flow.auth-flow.requestSignupVerification',
  'api::auth-flow.auth-flow.verifySignup',
  'api::auth-flow.auth-flow.sendSignupWelcome',
  'api::auth-flow.auth-flow.requestPasswordReset',
  'api::auth-flow.auth-flow.resetPassword',
];

const authenticatedActions: string[] = [
  'plugin::users-permissions.user.me',
  'plugin::users-permissions.auth.logout',
  'plugin::users-permissions.auth.changePassword',

  // Upload (listing/ad image uploads)
  'plugin::upload.content-api.upload',
  'plugin::upload.content-api.find',
  'plugin::upload.content-api.findOne',
  'plugin::upload.content-api.destroy',

  // Listing
  'api::listing.listing.create',
  'api::listing.listing.find',
  'api::listing.listing.findOne',
  'api::listing.listing.update',
  'api::listing.listing.delete',
  // PREMIUM_P1_TARGETED_FIX_REPORT.md BUG-PREM-001: server-authoritative
  // rocket activation -- verifies entitlement (premium rocket credit or
  // an unconsumed verified doping_* purchase) instead of trusting a
  // client-supplied isDoping/rocketEndsAt.
  'api::listing.listing.activateRocket',

  // Ad
  'api::ad.ad.create',
  'api::ad.ad.find',
  'api::ad.ad.findOne',
  'api::ad.ad.update',
  'api::ad.ad.delete',

  // Offer
  'api::offer.offer.create',
  'api::offer.offer.find',
  'api::offer.offer.findOne',
  'api::offer.offer.update',
  'api::offer.offer.delete',
  'api::offer.offer.updateByOfferId',
  'api::offer.offer.deleteByOfferId',
  // O1 (OFFER_O1_CORE_FIX_REPORT.md): same pre-existing gap as
  // markRead/metricLike/metricFavorite before it -- markSeen uses
  // auth:{scope:[]} but was never granted to the authenticated role
  // anywhere, confirmed live (a valid JWT still got Strapi's generic
  // 403, never reaching the controller). Offer "seen" tracking cannot
  // exist at all without this.
  'api::offer.offer.markSeen',

  // Message
  'api::message.message.create',
  'api::message.message.find',
  'api::message.message.findOne',
  'api::message.message.update',
  'api::message.message.delete',

  // Support Ticket
  'api::support-ticket.support-ticket.create',
  'api::support-ticket.support-ticket.find',
  'api::support-ticket.support-ticket.findOne',
  'api::support-ticket.support-ticket.update',
  'api::support-ticket.support-ticket.delete',

  // Support Ticket Message
  'api::support-ticket-message.support-ticket-message.create',
  'api::support-ticket-message.support-ticket-message.find',
  'api::support-ticket-message.support-ticket-message.findOne',
  'api::support-ticket-message.support-ticket-message.update',
  'api::support-ticket-message.support-ticket-message.delete',

  // Thread
  'api::thread.thread.create',
  'api::thread.thread.find',
  'api::thread.thread.findOne',
  'api::thread.thread.update',
  'api::thread.thread.delete',

  // Conversation custom endpoints
  'api::conversation.conversation.mine',
  'api::conversation.conversation.myMessages',
  'api::conversation.conversation.messagesByThread',
  'api::conversation.conversation.upsert',
  'api::conversation.conversation.sendMessage',
  // MESSAGING M2 (MESSAGING_M2_READ_UNREAD_FIX_REPORT.md) / PERMISSION_GAP_S5A
  // (PERMISSION_GAP_RELEASE_AUDIT.md PERM-N4 / PERM-N5 = BUG-M7): same
  // pre-existing gap as the logistics-load metric routes and
  // offer.markSeen -- markRead/deleteByThreadId use auth:{scope:[]} but
  // were never granted to the authenticated role anywhere, so every real
  // call 403'd (confirmed live in both M2's and S5A's integration tests).
  // Both handlers already enforce participant-only access at the query
  // level (userFilter(user) baked into the thread lookup) -- only the
  // permission grant was missing. Found and fixed independently by both
  // the messaging (M2) and permission-gap (S5A) sprints; reconciled here
  // during release/preflight-integration merge.
  'api::conversation.conversation.markRead',
  'api::conversation.conversation.deleteByThreadId',

  // Notification
  'api::notification.notification.create',
  'api::notification.notification.find',
  'api::notification.notification.findOne',
  'api::notification.notification.update',
  'api::notification.notification.delete',
  // PERMISSION_GAP_S5A (PERMISSION_GAP_RELEASE_AUDIT.md PERM-N1): same
  // gap as above -- markRead uses auth:{scope:[]} but was never granted
  // to the authenticated role. The controller's own owner-match (or
  // broadcast-bypass) check was already correct; only the permission
  // grant was missing.
  'api::notification.notification.markRead',
  // NOTIFICATION_N1_SECURITY_FIX_REPORT.md BUG-NOTIF-001: the new
  // per-domain-verified replacement for the social-interaction
  // notifications formerly routed through the generic (spoofable) create.
  'api::notification.notification.createDomainEvent',

  // Hub content
  'api::hub-content.hub-content.create',
  'api::hub-content.hub-content.find',
  'api::hub-content.hub-content.findOne',
  'api::hub-content.hub-content.update',
  'api::hub-content.hub-content.delete',

  // Profile settings
  'api::profile-setting.profile-setting.create',
  'api::profile-setting.profile-setting.find',
  'api::profile-setting.profile-setting.findOne',
  'api::profile-setting.profile-setting.update',
  'api::profile-setting.profile-setting.delete',

  // Engagement API v1 (ENGAGEMENT_API_CONTRACT.md) — confirmed via a real
  // boot (Faz B-V) that these action IDs were NOT granted to the
  // authenticated role anywhere in code, causing every /engagements/*
  // call to 403 on any freshly-provisioned Strapi instance (a real
  // deploy/dev/production instance may have had these clicked on
  // manually in the admin panel at some point — out-of-band, not
  // reproducible — which is exactly the gap this array exists to close).
  'api::engagement.engagement-v1.putLike',
  'api::engagement.engagement-v1.deleteLike',
  'api::engagement.engagement-v1.putFavorite',
  'api::engagement.engagement-v1.deleteFavorite',
  'api::engagement.engagement-v1.postView',
  // Faz D8-V-B: same defensive-bootstrap reasoning as the block above,
  // for the new narrow profile-view-target lookup (auth:false at the
  // route level already bypasses this in practice, same as postView —
  // added for the same "don't rely on that staying true" reason).
  'api::engagement.engagement-profile.getViewTarget',
  // PUB-PROFILE-B: same defensive-bootstrap reasoning, for the new
  // narrow public profile read (auth:false already bypasses this in
  // practice — added for the same "don't rely on that staying true"
  // reason).
  'api::public-profile.public-profile.getPublicProfile',
  // Legacy engagement toggle endpoints — same gap, pre-existing (not
  // introduced by Faz B), fixed here for the same reason.
  'api::engagement.engagement.toggleListingFavorite',
  'api::engagement.engagement.toggleProfileFavorite',
  'api::engagement.engagement.toggleListingLike',
  'api::engagement.engagement.toggleLogisticsLoadLike',
  'api::engagement.engagement.toggleFarmerQuestionLike',
  'api::engagement.engagement.toggleProcessedProductLike',
  'api::engagement.engagement.syncProfileShowcasePins',
  'api::engagement.engagement.syncOfflineListing',
  // listing-comment / listing-share (operationId-idempotent endpoints)
  'api::listing-comment.listing-comment.create',
  'api::listing-comment.listing-comment.delete',
  'api::listing-share.listing-share.create',

  // AI assistant
  'api::ai.ai.agriAssistant',
  'api::ai.ai.agriVision',
  'api::ai.ai.history',
  'api::ai.ai.usageSummary',
  'api::auth-flow.auth-flow.updateUsername',
  'api::auth-flow.auth-flow.registerPushToken',
  'api::auth-flow.auth-flow.unregisterPushToken',
  // PERMISSION_GAP_S5A (PERMISSION_GAP_RELEASE_AUDIT.md PERM-N2): same
  // gap as above -- deleteAccount uses auth:{scope:[]} but was never
  // granted to the authenticated role, confirmed live (the "Hesabi ve
  // Verileri Sil" button always 403'd for every user). The controller
  // is self-only and non-spoofable (userId/email/ownerId are all read
  // from ctx.state.user, never from the request body); only the
  // permission grant was missing.
  'api::auth-flow.auth-flow.deleteAccount',

  // Processed products module
  'api::processed-seller-stores.processed-seller-stores.mine',
  'api::processed-seller-stores.processed-seller-stores.upsert',
  'api::processed-products.processed-products.mine',
  'api::processed-product.processed-product.mine',
  'api::processed-products.processed-products.upsert',
  'api::processed-products.processed-products.delete',
  'api::processed-store-documents.processed-store-documents.mine',
  'api::processed-store-documents.processed-store-documents.create',
  'api::processed-store-documents.processed-store-documents.delete',
  'api::processed-admin.processed-admin.access',
  'api::processed-admin.processed-admin.stores',
  'api::processed-admin.processed-admin.storeReview',
  'api::processed-admin.processed-admin.products',
  'api::processed-admin.processed-admin.productReview',
  'api::processed-seller-payouts.processed-seller-payouts.mine',

  // Logistics module
  'api::logistics-load.logistics-load.create',
  'api::logistics-load.logistics-load.find',
  'api::logistics-load.logistics-load.findOne',
  'api::logistics-load.logistics-load.update',
  'api::logistics-load.logistics-load.delete',
  'api::logistics-load.logistics-load.nearby',
  // Faz D4-B: same pre-existing gap as the /engagements/* actions above —
  // these custom metric routes use auth:{scope:[]} (JWT + permission
  // required), but were never granted to the authenticated role anywhere
  // in code, confirmed via a real boot while writing D4-B's integration
  // tests (every call 403'd even with a valid JWT on a fresh instance).
  'api::logistics-load.logistics-load.metricLike',
  'api::logistics-load.logistics-load.metricFavorite',
  'api::logistics-vehicle.logistics-vehicle.create',
  'api::logistics-vehicle.logistics-vehicle.find',
  'api::logistics-vehicle.logistics-vehicle.findOne',
  'api::logistics-vehicle.logistics-vehicle.update',
  'api::logistics-vehicle.logistics-vehicle.delete',
  'api::logistics-vehicle.logistics-vehicle.nearby',
  'api::logistics-offer.logistics-offer.create',
  'api::logistics-offer.logistics-offer.find',
  'api::logistics-offer.logistics-offer.findOne',
  'api::logistics-offer.logistics-offer.update',
  'api::logistics-offer.logistics-offer.delete',
  'api::logistics-offer.logistics-offer.byLoad',
  'api::logistics-offer.logistics-offer.accept',
  'api::logistics-offer.logistics-offer.reject',
  // Purchase verify (authenticated)
  'api::purchase.purchase.verify',
  'api::promo.promo.redeem',
];

const syncUsersPermissionsRoleConfig = async (strapi: Core.Strapi) => {
  const roleService = strapi.plugin('users-permissions').service('role');
  const roles = await strapi.db.query('plugin::users-permissions.role').findMany();
  const publicRole = roles.find((r: any) => r.type === 'public');
  const authenticatedRole = roles.find((r: any) => r.type === 'authenticated');

  if (publicRole?.id) {
    const current = await roleService.findOne(publicRole.id);
    const permissions = current.permissions as PermissionsTree;
    enableMany(permissions, publicActions);
    await roleService.updateRole(publicRole.id, {
      permissions,
    });
  }

  if (authenticatedRole?.id) {
    const current = await roleService.findOne(authenticatedRole.id);
    const permissions = current.permissions as PermissionsTree;
    enableMany(permissions, authenticatedActions);
    await roleService.updateRole(authenticatedRole.id, {
      permissions,
    });
  }

  const pluginStore = strapi.store({ type: 'plugin', name: 'users-permissions' });
  const advanced = (await pluginStore.get({ key: 'advanced' })) as Record<string, unknown> | undefined;
  await pluginStore.set({
    key: 'advanced',
    value: {
      ...(advanced ?? {}),
      allow_register: true,
      email_confirmation: false,
      default_role: 'authenticated',
      unique_email: true,
    },
  });
};

const normalizeText = (v: unknown) => (v ?? '').toString().trim().toLowerCase();

const deleteMalformedOfferMessageThreadData = async (strapi: Core.Strapi) => {
  const isEmpty = (v: unknown) => (v ?? '').toString().trim() === '';

  // Offer: hem requester hem receiver bilgisi bos ise sil.
  try {
    const offers = await strapi.db.query('api::offer.offer').findMany();
    const all = Array.isArray(offers) ? offers : [];
    for (const row of all as any[]) {
      const reqEmail = normalizeText(row.requesterEmail);
      const reqProfile = normalizeText(row.requesterProfileId);
      const recvEmail = normalizeText(row.receiverEmail);
      const recvProfile = normalizeText(row.receiverProfileId);
      const malformed =
        isEmpty(reqEmail) &&
        isEmpty(reqProfile) &&
        isEmpty(recvEmail) &&
        isEmpty(recvProfile);
      if (!malformed) continue;
      if (!row.id) continue;
      try {
        await strapi.db.query('api::offer.offer').delete({ where: { id: row.id } });
      } catch (_) {}
    }
  } catch (_) {}

  // Message: threadId yoksa veya iki taraf kimliÄŸi tamamen boÅŸsa sil.
  try {
    const messages = await strapi.db.query('api::message.message').findMany();
    const all = Array.isArray(messages) ? messages : [];
    for (const row of all as any[]) {
      const threadId = normalizeText(row.threadId);
      const reqEmail = normalizeText(row.requesterEmail);
      const reqProfile = normalizeText(row.requesterProfileId);
      const recvEmail = normalizeText(row.receiverEmail);
      const recvProfile = normalizeText(row.receiverProfileId);
      const malformed =
        isEmpty(threadId) ||
        (isEmpty(reqEmail) &&
            isEmpty(reqProfile) &&
            isEmpty(recvEmail) &&
            isEmpty(recvProfile));
      if (!malformed) continue;
      if (!row.id) continue;
      try {
        await strapi.db.query('api::message.message').delete({ where: { id: row.id } });
      } catch (_) {}
    }
  } catch (_) {}

  // Thread: threadId yoksa veya iki taraf kimliÄŸi tamamen boÅŸsa sil.
  try {
    const threads = await strapi.db.query('api::thread.thread').findMany();
    const all = Array.isArray(threads) ? threads : [];
    for (const row of all as any[]) {
      const threadId = normalizeText(row.threadId);
      const reqEmail = normalizeText(row.requesterEmail);
      const reqProfile = normalizeText(row.requesterProfileId);
      const recvEmail = normalizeText(row.receiverEmail);
      const recvProfile = normalizeText(row.receiverProfileId);
      const malformed =
        isEmpty(threadId) ||
        (isEmpty(reqEmail) &&
            isEmpty(reqProfile) &&
            isEmpty(recvEmail) &&
            isEmpty(recvProfile));
      if (!malformed) continue;
      if (!row.id) continue;
      try {
        await strapi.db.query('api::thread.thread').delete({ where: { id: row.id } });
      } catch (_) {}
    }
  } catch (_) {}
};

const isSupportThreadId = (v: unknown) => normalizeText(v).startsWith('support_');

const deleteLegacySupportDataFromMessages = async (strapi: Core.Strapi) => {
  let deletedMessages = 0;
  let deletedThreads = 0;

  // Legacy support rows that were accidentally written into messages.
  try {
    const messages = await strapi.db.query('api::message.message').findMany();
    const all = Array.isArray(messages) ? messages : [];
    for (const row of all as any[]) {
      if (!isSupportThreadId(row.threadId)) continue;
      if (!row.id) continue;
      try {
        await strapi.db.query('api::message.message').delete({ where: { id: row.id } });
        deletedMessages += 1;
      } catch (_) {}
    }
  } catch (_) {}

  // Legacy support rows may also exist in thread collection.
  try {
    const threads = await strapi.db.query('api::thread.thread').findMany();
    const all = Array.isArray(threads) ? threads : [];
    for (const row of all as any[]) {
      if (!isSupportThreadId(row.threadId)) continue;
      if (!row.id) continue;
      try {
        await strapi.db.query('api::thread.thread').delete({ where: { id: row.id } });
        deletedThreads += 1;
      } catch (_) {}
    }
  } catch (_) {}

  return { deletedMessages, deletedThreads };
};

const cleanText = (v: unknown) => (v ?? '').toString().trim();

const normalizeSupportTicketNo = (v: unknown) => {
  let out = cleanText(v);
  if (!out) return '';
  if (out.toLowerCase().startsWith('support_')) {
    out = out.substring('support_'.length).trim();
  }
  return out;
};

const normalizeSupportSenderType = (v: unknown) => {
  const s = cleanText(v).toLowerCase();
  if (!s) return 'user';
  if (s === 'admin' || s === 'support' || s === 'staff') return 'support';
  if (s === 'system') return 'system';
  if (s === 'outgoing') return 'user';
  return s;
};

const parseMessageTimeMs = (row: Record<string, unknown>) => {
  const raw =
    cleanText(row.sentAt) ||
    cleanText(row.createdAt) ||
    cleanText(row.updatedAt) ||
    new Date().toISOString();
  const ms = Date.parse(raw);
  if (!Number.isNaN(ms)) return ms;
  return Date.now();
};

const extractSupportMessageText = (row: Record<string, unknown>) => {
  const message = cleanText(row.message);
  if (message) return message;
  const text = cleanText(row.text);
  if (text) return text;
  return '';
};

const pickSupportTicketNoFromMessage = (row: Record<string, unknown>) => {
  return (
    normalizeSupportTicketNo(row.ticketNo) ||
    normalizeSupportTicketNo(row.ticketId) ||
    normalizeSupportTicketNo(row.supportTicketId) ||
    normalizeSupportTicketNo(row.threadId)
  );
};

const backfillSupportTicketMessageLinks = async (strapi: Core.Strapi) => {
  let linkedMessages = 0;
  let updatedMessages = 0;
  let updatedTickets = 0;
  let skippedMessages = 0;

  const tickets = await strapi.db.query('api::support-ticket.support-ticket').findMany();
  const ticketList = (Array.isArray(tickets) ? tickets : []) as any[];
  if (ticketList.length === 0) {
    return { linkedMessages, updatedMessages, updatedTickets, skippedMessages };
  }

  const ticketByNo = new Map<string, any>();
  for (const t of ticketList) {
    const no = normalizeSupportTicketNo(t.ticketNo || t.id || t.documentId);
    if (!no) continue;
    ticketByNo.set(no.toLowerCase(), t);
  }

  const rows = await strapi.db
    .query('api::support-ticket-message.support-ticket-message')
    .findMany();
  const messages = (Array.isArray(rows) ? rows : []) as any[];

  const groupedByTicketId = new Map<
    number,
    Array<{
      text: string;
      senderType: string;
      senderName: string;
      atIso: string;
      atMs: number;
    }>
  >();

  for (const m of messages) {
    const row = m as Record<string, unknown>;
    const ticketNo = pickSupportTicketNoFromMessage(row);
    if (!ticketNo) {
      skippedMessages += 1;
      continue;
    }
    const ticket = ticketByNo.get(ticketNo.toLowerCase());
    if (!ticket?.id) {
      skippedMessages += 1;
      continue;
    }

    const senderType = normalizeSupportSenderType(row.senderType);
    const messageText = extractSupportMessageText(row);
    const atMs = parseMessageTimeMs(row);
    const atIso = new Date(atMs).toISOString();
    const senderName =
      cleanText(row.senderName) ||
      (senderType === 'support'
        ? 'Destek Ekibi'
        : cleanText(ticket.ownerName) || cleanText(ticket.ownerEmail) || 'Kullanici');

    const patch: Record<string, unknown> = {};
    if (normalizeSupportTicketNo(row.ticketNo) !== ticketNo) patch.ticketNo = ticketNo;
    if (normalizeSupportTicketNo(row.ticketId) !== ticketNo) patch.ticketId = ticketNo;
    if (normalizeSupportTicketNo(row.supportTicketId) !== ticketNo) {
      patch.supportTicketId = ticketNo;
    }
    if ((row as any).supportTicket !== ticket.id) patch.supportTicket = ticket.id;
    if (!cleanText(row.requesterEmail) && cleanText(ticket.ownerEmail)) {
      patch.requesterEmail = cleanText(ticket.ownerEmail);
    }
    if (!cleanText(row.requesterProfileId) && cleanText(ticket.ownerProfileId)) {
      patch.requesterProfileId = cleanText(ticket.ownerProfileId);
    }
    if (!cleanText(row.receiverEmail) && cleanText(ticket.ownerEmail)) {
      patch.receiverEmail = cleanText(ticket.ownerEmail);
    }
    if (!cleanText(row.receiverProfileId) && cleanText(ticket.ownerProfileId)) {
      patch.receiverProfileId = cleanText(ticket.ownerProfileId);
    }
    if (!cleanText(row.senderType)) patch.senderType = senderType;
    if (!cleanText(row.senderName) && senderName) patch.senderName = senderName;
    if (!cleanText(row.message) && messageText) patch.message = messageText;
    if (!cleanText(row.text) && messageText) patch.text = messageText;
    if (!cleanText(row.sentAt)) patch.sentAt = atIso;

    if (Object.keys(patch).length > 0 && m.id) {
      try {
        await strapi.db
          .query('api::support-ticket-message.support-ticket-message')
          .update({ where: { id: m.id }, data: patch });
        updatedMessages += 1;
      } catch (_) {}
    }
    if ((row as any).supportTicket !== ticket.id) linkedMessages += 1;

    if (messageText) {
      const list = groupedByTicketId.get(ticket.id) ?? [];
      list.push({
        text: messageText,
        senderType,
        senderName,
        atIso,
        atMs,
      });
      groupedByTicketId.set(ticket.id, list);
    }
  }

  for (const t of ticketList) {
    if (!t?.id) continue;
    const msgs = groupedByTicketId.get(t.id) ?? [];
    if (msgs.length === 0) continue;
    msgs.sort((a, b) => a.atMs - b.atMs);

    const last = msgs[msgs.length - 1];
    const conversation = msgs.map((x) => `[${x.atIso}] ${x.senderName}: ${x.text}`).join('\n');
    const updateData: Record<string, unknown> = {
      conversation,
      lastMessageAt: last.atIso,
      lastMessagePreview: last.text,
    };

    const status = cleanText(t.status).toLowerCase();
    if (status !== 'closed') {
      if (last.senderType === 'support') {
        updateData.status = 'answered';
      } else if (last.senderType === 'user') {
        updateData.status = 'open';
      }
    }
    if (!cleanText(t.ownerName)) {
      const firstUser = msgs.find((x) => x.senderType === 'user');
      if (firstUser?.senderName) {
        updateData.ownerName = firstUser.senderName;
      }
    }

    try {
      await strapi.db
        .query('api::support-ticket.support-ticket')
        .update({ where: { id: t.id }, data: updateData });
      updatedTickets += 1;
    } catch (_) {}
  }

  return { linkedMessages, updatedMessages, updatedTickets, skippedMessages };
};

const runSupportBackfillOnce = async (strapi: Core.Strapi) => {
  const appStore = strapi.store({ type: 'core', name: 'bootstrap' });
  const key = 'support_backfill_v1_done';
  const already = await appStore.get({ key });
  if (already === true) {
    strapi.log.info('Support backfill skipped (already done).');
    return;
  }
  const result = await backfillSupportTicketMessageLinks(strapi);
  await appStore.set({ key, value: true });
  strapi.log.info(
    `Support backfill completed: linkedMessages=${result.linkedMessages}, updatedMessages=${result.updatedMessages}, updatedTickets=${result.updatedTickets}, skippedMessages=${result.skippedMessages}.`,
  );
};

const runPremiumFlagsBackfill = async (strapi: Core.Strapi) => {
  try {
    const rows = await strapi.db.query('api::profile-setting.profile-setting').findMany({
      select: ['id'],
      orderBy: { id: 'asc' },
    } as any);

    for (const row of Array.isArray(rows) ? rows : []) {
      const id = Number((row as any)?.id);
      if (!Number.isInteger(id) || id <= 0) continue;
      try {
        const entry = await strapi.entityService.findOne(
          'api::profile-setting.profile-setting' as any,
          id as any,
          {
            fields: ['profileId', 'activePremium', 'activePremiumSubscription'],
          },
        );
        await syncOwnerPremiumFlags(strapi, entry as Record<string, unknown>);
      } catch (_) {}
    }

    strapi.log.info('Premium listing flag backfill completed.');
  } catch (e) {
    strapi.log.error(`Premium listing flag backfill failed: ${e}`);
  }
};

const registerUserDeleteCleanupLifecycle = (strapi: Core.Strapi) => {
  const userUid = 'plugin::users-permissions.user';
  const cleanupUser = async (
    user: Record<string, unknown> | null | undefined,
  ) => {
    const email = normalizeCleanupEmail(user?.email);
    if (!email) return;
    const ownerId = ownerIdFromCleanupEmail(email);
    try {
      const result = await cleanupOwnerEmbeddedHubContent(strapi, {
        ownerId,
        email,
      });
      strapi.log.info(
        `Account embedded hub cleanup: email=${email}, rows=${result.hubRowsUpdated}, hubComments=${result.hubCommentsRemoved}, farmerQuestions=${result.farmerQuestionsArchived}, farmerAnswers=${result.farmerAnswersRemoved}, farmerCommentRows=${result.farmerCommentRowsArchived}.`,
      );
    } catch (e) {
      strapi.log.error(`Account embedded hub cleanup failed for ${email}: ${e}`);
    }
  };

  strapi.db.lifecycles.subscribe({
    models: [userUid],
    async beforeDelete(event) {
      const where = event?.params?.where ?? {};
      const user = (await strapi.db.query(userUid).findOne({
        where,
        select: ['id', 'email'],
      } as any)) as Record<string, unknown> | null;
      await cleanupUser(user);
    },
    async beforeDeleteMany(event) {
      const where = event?.params?.where ?? {};
      const users = (await strapi.db.query(userUid).findMany({
        where,
        select: ['id', 'email'],
        limit: 1000,
      } as any)) as Record<string, unknown>[];
      for (const user of Array.isArray(users) ? users : []) {
        await cleanupUser(user);
      }
    },
  });
};

export default {
  register() {},

  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    await ensureEngagementUniqueIndexes(strapi);
    // Order matters: the backfill must assign a real, unique listingNo to
    // every existing row BEFORE the unique index is created, or index
    // creation would fail against pre-existing nulls/duplicates from the
    // old client-derived numbering scheme.
    await runListingNoBackfillOnce(strapi);
    await ensureListingNoUniqueIndex(strapi);
    registerUserDeleteCleanupLifecycle(strapi);
    await syncUsersPermissionsRoleConfig(strapi);
    const cleanupEnabled =
      (process.env.CLEANUP_MALFORMED_TEST_DATA ?? '').toLowerCase() === 'true';
    if (cleanupEnabled) {
      await deleteMalformedOfferMessageThreadData(strapi);
      strapi.log.info(
        'Malformed offer/message/thread cleanup executed (CLEANUP_MALFORMED_TEST_DATA=true).',
      );
    } else {
      strapi.log.info(
        'Malformed data cleanup skipped (set CLEANUP_MALFORMED_TEST_DATA=true to run once).',
      );
    }

    const cleanupLegacySupportEnabled =
      (process.env.CLEANUP_LEGACY_SUPPORT_MESSAGES ?? '').toLowerCase() ===
      'true';
    if (cleanupLegacySupportEnabled) {
      const result = await deleteLegacySupportDataFromMessages(strapi);
      strapi.log.info(
        `Legacy support cleanup executed (CLEANUP_LEGACY_SUPPORT_MESSAGES=true). Deleted messages=${result.deletedMessages}, deleted threads=${result.deletedThreads}.`,
      );
    } else {
      strapi.log.info(
        'Legacy support cleanup skipped (set CLEANUP_LEGACY_SUPPORT_MESSAGES=true to run once).',
      );
    }

    try {
      await runSupportBackfillOnce(strapi);
    } catch (e) {
      strapi.log.error(`Support backfill failed: ${e}`);
    }

    await runOfferIdDedupeOnce(strapi);
    await runPremiumFlagsBackfill(strapi);
    strapi.log.info('Users & Permissions roles synced from bootstrap.');
  },
};









