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

/**
 * Review follow-up (unverified-claim ownership lock): `everAuthenticated`
 * is a one-way, "once true, always true" flag -- it must never regress
 * from true back to false just because a LATER write for the SAME
 * transactionId (e.g. a webhook renewal, or a retried verify()) happens
 * not to carry it this time. Merging it here, in the ONE place that
 * decides create-vs-update for every `purchase-event` write (the
 * interactive verify() path AND both webhook paths), means no caller has
 * to get this merge right individually.
 */
export const upsertPurchaseEvent = async (
  strapi: Core.Strapi,
  data: Record<string, unknown>,
) => {
  const tx = asString(data.transactionId);
  if (!tx) throw new Error('transactionId boş.');
  const existing = await strapi.db.query(PURCHASE_EVENT_UID).findOne({
    where: { transactionId: tx },
  } as any);
  const everAuthenticated =
    existing?.everAuthenticated === true || data.everAuthenticated === true;
  const merged = { ...data, everAuthenticated };
  if (existing?.id) {
    return (await strapi.entityService.update(
      PURCHASE_EVENT_UID as any,
      existing.id as any,
      { data: merged },
    )) as Record<string, unknown>;
  }
  return (await strapi.entityService.create(PURCHASE_EVENT_UID as any, {
    data: merged,
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
  purchasedAt?: string;
}) => ({
  categoryTitle: input.categoryTitle,
  planTitle: input.planTitle,
  priceTl: input.priceTl,
  // `createdAt` is, and always was, WHEN OUR BACKEND PROCESSED this write --
  // never changed here, so an already-existing history record's own
  // meaning (and every existing reader of it) stays exactly as it was.
  createdAt: nowIso(),
  // Review follow-up (real production symptom: an old, already-expired
  // transaction got RE-PROCESSED weeks later -- e.g. StoreKit redelivering
  // a stale unfinished transaction on relaunch -- and its history entry's
  // only date, `createdAt` above, then showed TODAY, as if it had just
  // been bought). `purchasedAt` is the store's own verified purchase time
  // for this exact transactionId, stable no matter how many times/how
  // late this record gets re-processed. Additive and nullable -- a record
  // written before this field existed, or for a provider/path that could
  // not supply it, simply has `purchasedAt: null` and falls back to
  // `createdAt` wherever it is displayed; nothing existing changes.
  purchasedAt: input.purchasedAt || null,
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
  transactionId?: string;
  originalTransactionId?: string;
  purchasedAt?: string;
  // Review follow-up (idempotent-repair rocket reconciliation): when
  // present, used INSTEAD OF spec.rocketIncludedTotal for `rocketRemaining`
  // specifically -- `rocketIncludedTotal` (the plan's own nominal total)
  // is never affected. Only ever passed by the idempotent-repair path,
  // which reconciles already-consumed rocket-activation records for this
  // exact subscription before repairing a missing entitlement; a genuinely
  // new purchase/renewal never passes this and always gets the full,
  // fresh package, exactly as before.
  rocketRemainingOverride?: number;
}) => {
  const spec = PREMIUM_PRODUCTS[resolveCanonicalProductId(input.productId)];
  if (!spec) return null;
  // Prefer the store's own verified purchase time (see `purchasedAt`'s doc
  // comment on `toHistoryRecord` above) for display -- falls back to "now"
  // only when the provider/path genuinely has no such value. This field is
  // ONLY ever used as a label; `endsAt` below never depends on it (it
  // comes from `premiumEndsAt`/the store's own expiry whenever one is
  // given, which is every real verified purchase).
  const startsAt = parseIso(input.purchasedAt) || new Date();
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
    rocketRemaining: input.rocketRemainingOverride ?? spec.rocketIncludedTotal,
    rocketDays: spec.rocketDays,
    premiumProfileEnabled: true,
    unlimitedListings: true,
    hasAiAssistant: spec.hasAiAssistant,
    hasLiveSupport: spec.hasLiveSupport,
    paymentProvider: input.provider,
    // Review follow-up (Premium ownership audit): records WHICH
    // transaction this entitlement actually came from -- see
    // upsertProfilePurchase's own doc comment on `matchesCurrentEntitlement`
    // for why this is needed. Additive only; existing readers that only
    // look at endsAt/planTitle/etc. are unaffected.
    transactionId: input.transactionId || null,
    originalTransactionId: input.originalTransactionId || null,
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
    originalTransactionId?: string;
    purchasedAt?: string;
    rocketRemainingOverride?: number;
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
    purchasedAt: input.purchasedAt,
  });
  const history = pushUniqueRecord(
    existing?.purchaseHistory ?? existing?.purchaseRecords,
    record,
  );

  let nextPremium = existing?.activePremium ?? existing?.activePremiumSubscription;

  // Review follow-up (Premium ownership audit): a DESTRUCTIVE update
  // below (nulling activePremium, or turning its autoRenew off) must
  // only ever apply when THIS request's own transaction is the one
  // CURRENTLY represented in activePremium -- otherwise a stale/
  // duplicate/late notification about a DIFFERENT, already-superseded
  // transaction (e.g. Apple re-sending an old notification for an
  // original transaction this owner has since replaced by genuinely
  // re-subscribing with a NEW one) could wipe out a CURRENTLY VALID
  // entitlement that a separate transaction produced. `activePremium`
  // did not previously record which transaction backs it at all --
  // premiumPayloadForProduct now stores it, so a real match can be
  // required going forward. A row with NO stored identity (either
  // because there is no current entitlement to protect, or because it
  // predates this field) is never treated as a confirmed match --
  // "unknown" never authorizes a destructive action, the same posture
  // `everAuthenticated` already uses elsewhere in this file. This is a
  // one-directional safety net only: establishing a NEW entitlement
  // (the `verified`/no-forcePremiumStatus branch below) is unaffected --
  // a genuinely verified purchase always legitimately becomes the
  // current entitlement, whichever transaction it came from.
  const currentPremiumRecord =
    nextPremium && typeof nextPremium === 'object'
      ? (nextPremium as Record<string, unknown>)
      : null;
  const currentPremiumTx =
    asString(currentPremiumRecord?.originalTransactionId) ||
    asString(currentPremiumRecord?.transactionId);
  const thisTx = asString(input.originalTransactionId) || asString(input.transactionId);
  const matchesCurrentEntitlement = currentPremiumTx !== '' && currentPremiumTx === thisTx;

  // Review follow-up (same-subscription renewal ordering -- considered and
  // REJECTED): tried gating the destructive branches below on "this
  // event's own claimed expiry is not earlier than what's already on
  // file", to stop a late notification about an OLDER renewal period from
  // nulling a NEWER one under the SAME originalTransactionId. That broke
  // two genuine, previously-passing cases (Apple + Google webhook tests):
  // a REAL expiry/refund/revocation legitimately reports an end time
  // EARLIER than a prior, more optimistic stored estimate -- that is what
  // "it ended" means, not staleness. Ordering for the webhook path is
  // already handled correctly, at the per-transaction-row level, by the
  // existing `signedDate <= lastSigned` check against
  // `payload.appleLastSignedDate` in appleWebhook (and the Google
  // webhook's own equivalent) -- proven by the existing
  // "renewal uses the VERIFIED expiry; duplicates and out-of-order
  // (older signedDate) are ignored" test below, which is exactly the
  // same-originalTransactionId / old-notification-after-newer-renewal
  // scenario. `matchesCurrentEntitlement` alone is correct here.
  const canApplyDestructiveUpdate = matchesCurrentEntitlement;

  const premiumPayload = premiumPayloadForProduct({
    productId: input.productId,
    provider: input.provider,
    planTitle: input.planTitle,
    priceTl: input.priceTl,
    premiumEndsAt: input.premiumEndsAt,
    autoRenew: input.autoRenew,
    transactionId: input.transactionId,
    originalTransactionId: input.originalTransactionId,
    purchasedAt: input.purchasedAt,
    rocketRemainingOverride: input.rocketRemainingOverride,
  });
  if (premiumPayload && (!input.forcePremiumStatus || input.forcePremiumStatus === 'verified')) {
    nextPremium = premiumPayload;
  }
  if (
    premiumPayload &&
    canApplyDestructiveUpdate &&
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
    canApplyDestructiveUpdate &&
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
 *
 * Review follow-up (unverified-claim ownership lock): a row is only
 * treated as a genuine, blocking prior claim when `everAuthenticated` is
 * NOT explicitly `false` -- i.e. it is either known-authenticated (was,
 * at some point, backed by a receipt/token the provider's own signature/
 * API check genuinely accepted -- see `everAuthenticated`'s own doc
 * comment on `upsertPurchaseEvent` and where callers set it) or UNKNOWN
 * (a legacy row written before this field existed, `undefined`/`null` --
 * stays protective, exactly as before this fix, never auto-relaxed just
 * because its reliability cannot be determined). Only a row explicitly
 * recorded as `everAuthenticated === false` -- a transaction identity
 * that, across every attempt seen so far, was NEVER backed by a receipt
 * the provider itself actually authenticated (an empty receipt, a bad
 * signature, or Apple's own non-crypto bundle/product mismatch, none of
 * which carry the provider's own transactionId) -- is excluded: an
 * unverified CLIENT CLAIM on an identity must never win a permanent
 * ownership lock over it.
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
  return (
    rows.find(
      (r) => asString(r.ownerProfileId) !== ownerProfileId && r.everAuthenticated !== false,
    ) ?? null
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
