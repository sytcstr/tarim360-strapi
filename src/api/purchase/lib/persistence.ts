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

  let nextPremium = existing?.activePremium ?? existing?.activePremiumSubscription;
  const premiumPayload = premiumPayloadForProduct({
    productId: input.productId,
    provider: input.provider,
    planTitle: input.planTitle,
    priceTl: input.priceTl,
    premiumEndsAt: input.premiumEndsAt,
    autoRenew: input.autoRenew,
  });
  if (premiumPayload && (!input.forcePremiumStatus || input.forcePremiumStatus === 'verified')) {
    nextPremium = premiumPayload;
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
  ids: { transactionIds?: string[]; purchaseTokens?: string[]; originalTransactionIds?: string[] },
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
  return rows.find((r) => asString(r.ownerProfileId) !== ownerProfileId) ?? null;
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
