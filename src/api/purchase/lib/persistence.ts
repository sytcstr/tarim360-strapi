import type { Core } from '@strapi/strapi';
import {
  asString,
  nowIso,
  parseIso,
  PREMIUM_PRODUCTS,
  Provider,
  PurchaseStatus,
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
}) => {
  const spec = PREMIUM_PRODUCTS[input.productId];
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
    autoRenew: true,
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
