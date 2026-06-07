import { PREMIUM_PRODUCTS, asString, parseIso } from '../../purchase/lib/catalog';
import { normalizeEmail, readIdentity } from '../../../utils/identity';
import { normalizePromoCode } from '../../../utils/promo';

const PROMO_CODE_UID = 'api::promo-code.promo-code';
const PROMO_REDEMPTION_UID = 'api::promo-redemption.promo-redemption';
const PROFILE_SETTING_UID = 'api::profile-setting.profile-setting';
const MAX_HISTORY = 250;

const asInt = (value: unknown, fallback = 0): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.trunc(parsed);
};

const asBool = (value: unknown, fallback = false): boolean => {
  if (typeof value === 'boolean') return value;
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') {
    return true;
  }
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') {
    return false;
  }
  return fallback;
};

const pushUniqueHistoryRecord = (
  listRaw: unknown,
  record: Record<string, unknown>,
): Record<string, unknown>[] => {
  const tx = asString(record.transactionId);
  const list = Array.isArray(listRaw)
    ? listRaw.filter((x) => x && typeof x === 'object')
    : [];
  const out = list
    .map((x) => ({ ...(x as Record<string, unknown>) }))
    .filter((x) => asString(x.transactionId) !== tx);
  out.unshift(record);
  if (out.length > MAX_HISTORY) out.length = MAX_HISTORY;
  return out;
};

const buildSubscriptionPayload = (input: {
  productId: string;
  currentPremium: Record<string, unknown> | null;
  allowWhenPremiumActive: boolean;
}) => {
  const spec = PREMIUM_PRODUCTS[input.productId];
  if (!spec) {
    throw new Error('Promosyon kodu icin premium paketi tanimli degil.');
  }

  const now = new Date();
  const current = input.currentPremium ?? null;
  const currentEndsAt = parseIso(current?.endsAt);
  const hasActiveCurrent =
    current != null &&
    currentEndsAt != null &&
    currentEndsAt.getTime() > now.getTime();

  if (hasActiveCurrent && !input.allowWhenPremiumActive) {
    throw new Error(
      'Hesabinizda aktif premium varken bu promosyon kodu kullanilamaz.',
    );
  }

  if (!hasActiveCurrent) {
    return {
      planTitle: spec.planTitle,
      priceTl: spec.priceTl,
      startedAt: now.toISOString(),
      endsAt: new Date(
        now.getTime() + spec.durationDays * 24 * 60 * 60 * 1000,
      ).toISOString(),
      autoRenew: false,
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
      paymentProvider: 'promo_code',
    };
  }

  const currentPrice = asInt(current?.priceTl);
  const useIncomingPlan = spec.priceTl >= currentPrice;
  return {
    ...(current as Record<string, unknown>),
    planTitle: useIncomingPlan
      ? spec.planTitle
      : (asString(current?.planTitle) || spec.planTitle),
    priceTl: currentPrice > spec.priceTl ? currentPrice : spec.priceTl,
    startedAt: asString(current?.startedAt) || now.toISOString(),
    endsAt: new Date(
      currentEndsAt!.getTime() + spec.durationDays * 24 * 60 * 60 * 1000,
    ).toISOString(),
    autoRenew: false,
    smartAdIncludedTotal:
      asInt(current?.smartAdIncludedTotal) + spec.smartAdIncludedTotal,
    smartAdRemaining:
      asInt(current?.smartAdRemaining) + spec.smartAdIncludedTotal,
    smartAdDays: Math.max(asInt(current?.smartAdDays), spec.smartAdDays),
    rocketIncludedTotal:
      asInt(current?.rocketIncludedTotal) + spec.rocketIncludedTotal,
    rocketRemaining:
      asInt(current?.rocketRemaining) + spec.rocketIncludedTotal,
    rocketDays: Math.max(asInt(current?.rocketDays), spec.rocketDays),
    premiumProfileEnabled: true,
    unlimitedListings: true,
    hasAiAssistant: asBool(current?.hasAiAssistant) || spec.hasAiAssistant,
    hasLiveSupport: asBool(current?.hasLiveSupport) || spec.hasLiveSupport,
    paymentProvider: 'promo_code',
  };
};

const findPromoByCode = async (codeNormalized: string) => {
  return strapi.entityService.findMany(PROMO_CODE_UID as any, {
    filters: {
      codeNormalized,
    },
    limit: 1,
    fields: [
      'code',
      'codeNormalized',
      'title',
      'description',
      'premiumProductId',
      'isActive',
      'startsAt',
      'endsAt',
      'usageLimit',
      'perUserLimit',
      'allowWhenPremiumActive',
      'grantMessage',
      'redemptionCount',
      'lastRedeemedAt',
    ],
    populate: {
      targetUser: {
        fields: ['id', 'email', 'blocked'],
      },
    },
  });
};

export default {
  async redeem(ctx) {
    const identity = readIdentity(ctx);
    if (!identity) {
      return ctx.unauthorized('Giris yapmadan promosyon kodu kullanamazsiniz.');
    }

    const userId = Number(ctx?.state?.user?.id ?? 0);
    if (!Number.isInteger(userId) || userId <= 0) {
      return ctx.unauthorized('Kullanici oturumu bulunamadi.');
    }

    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const codeNormalized = normalizePromoCode(body.code);
    if (!codeNormalized) {
      return ctx.badRequest('Promosyon kodu zorunludur.');
    }

    const promoRows = (await findPromoByCode(codeNormalized)) as any[];
    const promo = Array.isArray(promoRows) ? promoRows[0] : null;
    if (!promo?.id) {
      return ctx.badRequest('Promosyon kodu bulunamadi.');
    }

    if (!asBool(promo.isActive, true)) {
      return ctx.badRequest('Bu promosyon kodu pasif durumda.');
    }

    const now = new Date();
    const startsAt = parseIso(promo.startsAt);
    const endsAt = parseIso(promo.endsAt);
    if (startsAt && startsAt.getTime() > now.getTime()) {
      return ctx.badRequest('Bu promosyon kodu henuz aktif degil.');
    }
    if (endsAt && endsAt.getTime() < now.getTime()) {
      return ctx.badRequest('Bu promosyon kodunun suresi dolmus.');
    }

    const targetUserId = Number((promo.targetUser ?? {})?.id ?? 0);
    if (targetUserId > 0 && targetUserId != userId) {
      return ctx.badRequest('Bu promosyon kodu baska bir kullaniciya ozel.');
    }

    const redemptionRows = (await strapi.entityService.findMany(
      PROMO_REDEMPTION_UID as any,
      {
        filters: {
          promoCode: promo.id,
        },
        fields: ['id', 'userEmail'],
        populate: {
          user: {
            fields: ['id'],
          },
        },
        limit: 1000,
      },
    )) as any[];

    const totalUsage = Array.isArray(redemptionRows) ? redemptionRows.length : 0;
    const usageLimit = Math.max(0, asInt(promo.usageLimit, 1));
    if (usageLimit > 0 && totalUsage >= usageLimit) {
      return ctx.badRequest('Bu promosyon kodunun kullanim hakki doldu.');
    }

    const userUsage = (Array.isArray(redemptionRows) ? redemptionRows : []).filter(
      (row) =>
        Number((row?.user ?? {})?.id ?? 0) == userId ||
        normalizeEmail(row?.userEmail) == identity.email,
    ).length;
    const perUserLimit = Math.max(0, asInt(promo.perUserLimit, 1));
    if (perUserLimit > 0 && userUsage >= perUserLimit) {
      return ctx.badRequest('Bu promosyon kodunu daha once kullandiniz.');
    }

    const productId = asString(promo.premiumProductId);
    const spec = PREMIUM_PRODUCTS[productId];
    if (!spec) {
      return ctx.badRequest('Promosyon kodu paketi tanimsiz.');
    }

    const existingProfile = (await strapi.db.query(PROFILE_SETTING_UID).findOne({
      where: { profileId: identity.ownerId },
    } as any)) as Record<string, unknown> | null;
    const nextPremium = buildSubscriptionPayload({
      productId,
      currentPremium:
        ((existingProfile?.activePremium ??
          existingProfile?.activePremiumSubscription ??
          null) as Record<string, unknown> | null),
      allowWhenPremiumActive: asBool(promo.allowWhenPremiumActive, false),
    });

    const transactionId = `PROMO-${promo.id}-${userId}-${Date.now()}`;
    const record = {
      categoryTitle: 'Promosyon Kodu',
      planTitle: `${spec.planTitle} - ${asString(promo.title) || 'Hediye Kod'}`,
      priceTl: 0,
      createdAt: now.toISOString(),
      paymentProvider: 'promo_code',
      transactionId,
      productId,
    };

    const history = pushUniqueHistoryRecord(
      existingProfile?.purchaseHistory ?? existingProfile?.purchaseRecords,
      record,
    );

    const profilePayload: Record<string, unknown> = {
      profileId: identity.ownerId,
      purchaseHistory: history,
      purchaseRecords: history,
      activePremium: nextPremium,
      activePremiumSubscription: nextPremium,
      purchaseUpdatedAt: now.toISOString(),
    };
    if (existingProfile?.id) {
      await strapi.entityService.update(
        PROFILE_SETTING_UID as any,
        existingProfile.id as any,
        {
          data: profilePayload,
        },
      );
    } else {
      await strapi.entityService.create(PROFILE_SETTING_UID as any, {
        data: profilePayload,
      });
    }

    const redemption = await strapi.entityService.create(
      PROMO_REDEMPTION_UID as any,
      {
        data: {
          promoCode: promo.id,
          user: userId,
          userEmail: identity.email,
          ownerProfileId: identity.ownerId,
          redeemedCode: asString(promo.code) || codeNormalized,
          grantedPlanTitle: spec.planTitle,
          grantedProductId: productId,
          grantedDurationDays: spec.durationDays,
          status: 'redeemed',
          transactionId,
          redeemedAt: now.toISOString(),
          grantSnapshot: {
            activePremium: nextPremium,
          },
        },
      },
    );

    await strapi.entityService.update(PROMO_CODE_UID as any, promo.id as any, {
      data: {
        redemptionCount: totalUsage + 1,
        lastRedeemedAt: now.toISOString(),
      },
    });

    ctx.body = {
      ok: true,
      redemptionId: redemption?.id ?? null,
      message:
        asString(promo.grantMessage) ||
        `${spec.planTitle} hesabina tanimlandi. Premium haklarin aktiflestirildi.`,
      planTitle: spec.planTitle,
      endsAt: nextPremium.endsAt,
    };
  },
};
