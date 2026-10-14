import type { Core } from '@strapi/strapi';
import {
  asString,
  nowIso,
  parseIso,
  PREMIUM_PRODUCTS,
  Provider,
  PurchaseStatus,
  resolveCanonicalProductId,
} from './catalog';
import { allowSandboxPurchaseEntitlements } from './config';

const PURCHASE_EVENT_UID = 'api::purchase-event.purchase-event';
const PROFILE_SETTING_UID = 'api::profile-setting.profile-setting';
const MAX_HISTORY = 250;

export const upsertPurchaseEvent = async (
  strapi: Core.Strapi,
  data: Record<string, unknown>,
) => {
  const tx = asString(data.transactionId);
  if (!tx) throw new Error('transactionId boş.');
  const existing = await strapi.db.query(PURCHASE_EVENT_UID).findOne({
    where: { transactionId: tx },
  } as any);
  if (existing?.id) {
    return (await strapi.entityService.update(
      PURCHASE_EVENT_UID as any,
      existing.id as any,
      { data },
    )) as Record<string, unknown>;
  }
  return (await strapi.entityService.create(PURCHASE_EVENT_UID as any, {
    data,
  })) as Record<string, unknown>;
};

export const findPurchaseEvent = async (
  strapi: Core.Strapi,
  where: Record<string, unknown>,
) =>
  (await strapi.db.query(PURCHASE_EVENT_UID).findOne({ where } as any)) as
    | Record<string, unknown>
    | null;

const toHistoryRecord = (input: {
  categoryTitle: string;
  planTitle: string;
  priceTl: number;
  paymentProvider: Provider;
  transactionId: string;
  productId: string;
}) => ({
  categoryTitle: input.categoryTitle,
  planTitle: input.planTitle,
  priceTl: input.priceTl,
  createdAt: nowIso(),
  paymentProvider: input.paymentProvider,
  transactionId: input.transactionId,
  productId: input.productId,
});

const pushUniqueRecord = (
  listRaw: unknown,
  record: Record<string, unknown>,
): Record<string, unknown>[] => {
  const list = Array.isArray(listRaw)
    ? listRaw.filter((x) => x && typeof x === 'object')
    : [];
  const tx = asString(record.transactionId);
  const out = list
    .map((x) => ({ ...(x as Record<string, unknown>) }))
    .filter((x) => asString(x.transactionId) !== tx);
  out.unshift(record);
  if (out.length > MAX_HISTORY) out.length = MAX_HISTORY;
  return out;
};

const premiumPayloadForProduct = (input: {
  productId: string;
  provider: Provider;
  planTitle: string;
  priceTl: number;
  premiumEndsAt?: string;
  autoRenew?: boolean;
}) => {
  const spec = PREMIUM_PRODUCTS[resolveCanonicalProductId(input.productId)];
  if (!spec) return null;
  const startsAt = new Date();
  const parsedEnds = parseIso(input.premiumEndsAt);
  const endsAt =
    parsedEnds ||
    new Date(startsAt.getTime() + spec.durationDays * 24 * 60 * 60 * 1000);
  return {
    planTitle: input.planTitle || spec.planTitle,
    priceTl: input.priceTl > 0 ? input.priceTl : spec.priceTl,
    startedAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    autoRenew: input.autoRenew ?? true,
    smartAdIncludedTotal: spec.smartAdIncludedTotal,
    smartAdRemaining: spec.smartAdIncludedTotal,
    smartAdDays: spec.smartAdDays,
    rocketIncludedTotal: spec.rocketIncludedTotal,
    rocketRemaining: spec.rocketIncludedTotal,
    rocketDays: spec.rocketDays,
    premiumProfileEnabled: true,
    unlimitedListings: true,
    hasAiAssistant: spec.hasAiAssistant,
    hasLiveSupport: spec.hasLiveSupport,
    paymentProvider: input.provider,
  };
};

export const upsertProfilePurchase = async (
  strapi: Core.Strapi,
  input: {
    ownerId: string;
    categoryTitle: string;
    planTitle: string;
    priceTl: number;
    provider: Provider;
    transactionId: string;
    productId: string;
    premiumEndsAt?: string;
    forcePremiumStatus?: PurchaseStatus;
    autoRenew?: boolean;
    /** "Paketler ve Fiyatlar" audit follow-up -- see the entitlement
     * guard below. Undefined/empty for Google (no equivalent signal). */
    storeEnvironment?: string;
  },
) => {
  const ownerId = asString(input.ownerId);
  if (!ownerId) return;
  const existing = (await strapi.db
    .query(PROFILE_SETTING_UID)
    .findOne({ where: { profileId: ownerId } } as any)) as
    | Record<string, unknown>
    | null;

  const record = toHistoryRecord({
    categoryTitle: input.categoryTitle,
    planTitle: input.planTitle,
    priceTl: input.priceTl,
    paymentProvider: input.provider,
    transactionId: input.transactionId,
    productId: input.productId,
  });
  const history = pushUniqueRecord(
    existing?.purchaseHistory ?? existing?.purchaseRecords,
    record,
  );

  const existingPremium = existing?.activePremium ?? existing?.activePremiumSubscription;
  let nextPremium = existingPremium;
  const premiumPayload = premiumPayloadForProduct({
    productId: input.productId,
    provider: input.provider,
    planTitle: input.planTitle,
    priceTl: input.priceTl,
    premiumEndsAt: input.premiumEndsAt,
    autoRenew: input.autoRenew,
  });

  /**
   * "Paketler ve Fiyatlar" audit follow-up (SECOND PASS -- corrects the
   * first pass's own guard): tagging `purchase-event` rows by
   * environment, by itself, only keeps the two pools from false-
   * CONFLICTING at the ownership-lookup level -- it says nothing about
   * what gets WRITTEN to a profile's real entitlement.
   *
   * The FIRST pass only blocked a sandbox request from overwriting an
   * ALREADY-real-and-active grant, and still let it GRANT a fresh
   * (tagged `sourceEnvironment: 'sandbox'`) entitlement when none
   * existed yet -- reasoned as "TestFlight testers need to see it
   * unlock". That reasoning doesn't hold here: this backend has no
   * separate sandbox entitlement store or test deployment (TestFlight
   * and the real App Store write the exact same profile-setting table),
   * so a "fresh" sandbox grant was really just a real production field
   * being set from an unpaid simulated transaction. The caller
   * (`purchase.ts`'s `verify()`) now rejects a sandbox Apple transaction
   * outright before it ever reaches here; this guard is kept as a
   * SECOND, defense-in-depth layer -- it also protects the `appleWebhook`
   * path and any legacy/pre-existing sandbox-tagged row -- and is
   * UNCONDITIONAL ON A REAL DEPLOYMENT: a sandbox request never writes
   * `activePremium`/`activePremiumSubscription`, active-and-real
   * existing grant or not.
   *
   * THIRD PASS: `allowSandboxPurchaseEntitlements()` (config.ts) lifts
   * this guard ONLY on a genuinely separate test-backend deployment
   * (its own database, no real customer data, gated to NODE_ENV
   * development/test) so a TestFlight build pointed at THAT deployment
   * can validate Premium end-to-end. Doping/listing-quota have no field
   * here at all (premiumPayloadForProduct returns null for non-premium
   * products); their own sandbox-isolation guard -- also gated by the
   * same flag -- lives where they're actually read: `activateRocket`
   * (listing.ts) and `canCreateNextNormalListing` (listing-metrics.ts).
   */
  const requestEnv = asString(input.storeEnvironment).toLowerCase();
  const isSandboxRequest = requestEnv === 'sandbox';
  const blockedBySandboxGuard = isSandboxRequest && !allowSandboxPurchaseEntitlements();

  if (blockedBySandboxGuard) {
    strapi.log.warn(
      `[purchase] sandbox transaction ${input.transactionId} for owner ${ownerId} was verified but did NOT modify activePremium/activePremiumSubscription -- no sandbox entitlement store exists (sandbox-vs-production entitlement guard).`,
    );
  } else {
    if (premiumPayload && (!input.forcePremiumStatus || input.forcePremiumStatus === 'verified')) {
      nextPremium = {
        ...premiumPayload,
        sourceEnvironment: requestEnv || 'production',
      };
    }
    if (
      premiumPayload &&
      (input.forcePremiumStatus === 'canceled' ||
        input.forcePremiumStatus === 'pending') &&
      nextPremium &&
      typeof nextPremium === 'object'
    ) {
      nextPremium = {
        ...(nextPremium as Record<string, unknown>),
        autoRenew: false,
      };
    }
    if (
      premiumPayload &&
      (input.forcePremiumStatus === 'expired' ||
        input.forcePremiumStatus === 'refunded' ||
        input.forcePremiumStatus === 'rejected')
    ) {
      nextPremium = null;
    }
  }

  const payload: Record<string, unknown> = {
    profileId: ownerId,
    purchaseHistory: history,
    purchaseRecords: history,
    purchaseUpdatedAt: nowIso(),
    activePremium: nextPremium,
    activePremiumSubscription: nextPremium,
  };

  if (existing?.id) {
    await strapi.entityService.update(PROFILE_SETTING_UID as any, existing.id as any, {
      data: payload,
    });
    return;
  }

  await strapi.entityService.create(PROFILE_SETTING_UID as any, {
    data: payload,
  });
};

/**
 * Provider identity ownership. A real store purchase is identified by what the
 * STORE says (Google purchaseToken / Apple original transaction id / the
 * provider's transaction id), never by an id the client chose. Returns the first
 * purchase event carrying any of these identities that belongs to a DIFFERENT
 * account, or null when every match (if any) belongs to `ownerProfileId`.
 */
export const findConflictingOwnerEvent = async (
  strapi: Core.Strapi,
  ownerProfileId: string,
  ids: {
    transactionIds?: string[];
    purchaseTokens?: string[];
    originalTransactionIds?: string[];
    /**
     * "Paketler ve Fiyatlar" audit follow-up: when provided (Apple only --
     * Google has no equivalent signal), a candidate row only counts as a
     * conflict when it is EITHER untagged (every row persisted before this
     * fix -- fail-safe, never silently exempted) OR tagged with this SAME
     * environment. A sandbox (TestFlight) transaction and a real
     * production one are now two separate pools that can never
     * false-conflict with each other; within either pool, the exact same
     * full ownership check as before still applies -- nothing here
     * loosens cross-account protection.
     */
    storeEnvironment?: string;
  },
): Promise<Record<string, unknown> | null> => {
  const clean = (list?: string[]) =>
    Array.from(new Set((list ?? []).map((x) => asString(x)).filter(Boolean)));
  const tx = clean(ids.transactionIds);
  const tokens = clean(ids.purchaseTokens);
  const originals = clean(ids.originalTransactionIds);
  const or: Record<string, unknown>[] = [];
  for (const id of [...tx, ...originals]) {
    or.push({ transactionId: id }, { originalTransactionId: id });
  }
  for (const t of tokens) or.push({ purchaseToken: t });
  if (or.length === 0) return null;
  const rows = (await strapi.db
    .query(PURCHASE_EVENT_UID)
    .findMany({ where: { $or: or }, limit: 50 } as any)) as Record<string, unknown>[];
  const requestedEnv = asString(ids.storeEnvironment);
  return (
    rows.find((r) => {
      if (asString(r.ownerProfileId) === ownerProfileId) return false;
      if (!requestedEnv) return true;
      const rowEnv = asString(r.storeEnvironment);
      if (!rowEnv) return true; // legacy/untagged -- fail-safe, still conflicts
      return rowEnv === requestedEnv;
    }) ?? null
  );
};

const identityLocks = new Map<string, Promise<unknown>>();

/** Serialises work per purchase identity so two accounts cannot both bind one purchase. */
export const withPurchaseIdentityLock = async <T>(
  keys: string[],
  fn: () => Promise<T>,
): Promise<T> => {
  const lockKeys = Array.from(new Set(keys.map((k) => asString(k)).filter(Boolean))).sort();
  const previous = lockKeys.map((k) => identityLocks.get(k)).filter(Boolean) as Promise<unknown>[];
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  for (const k of lockKeys) identityLocks.set(k, mine);
  try {
    await Promise.allSettled(previous);
    return await fn();
  } finally {
    release();
    for (const k of lockKeys) if (identityLocks.get(k) === mine) identityLocks.delete(k);
  }
};
