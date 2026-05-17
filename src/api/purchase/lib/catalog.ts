export type Provider = 'google_play' | 'app_store' | 'promo_code' | 'admin_grant';

export type PurchaseStatus =
  | 'verified'
  | 'pending'
  | 'canceled'
  | 'refunded'
  | 'expired'
  | 'rejected';

export const PREMIUM_PRODUCTS: Record<
  string,
  {
    planTitle: string;
    priceTl: number;
    durationDays: number;
    smartAdIncludedTotal: number;
    smartAdDays: number;
    rocketIncludedTotal: number;
    rocketDays: number;
    hasAiAssistant: boolean;
    hasLiveSupport: boolean;
  }
> = {
  premium_easy_yearly_999: {
    planTitle: 'Kolay Premium',
    priceTl: 999,
    durationDays: 365,
    smartAdIncludedTotal: 0,
    smartAdDays: 0,
    rocketIncludedTotal: 1,
    rocketDays: 1,
    hasAiAssistant: false,
    hasLiveSupport: false,
  },
  premium_eco_yearly_1599: {
    planTitle: 'Eco Premium',
    priceTl: 1599,
    durationDays: 365,
    smartAdIncludedTotal: 0,
    smartAdDays: 0,
    rocketIncludedTotal: 8,
    rocketDays: 7,
    hasAiAssistant: false,
    hasLiveSupport: false,
  },
  premium_pro_yearly_3599: {
    planTitle: 'Pro Premium',
    priceTl: 3599,
    durationDays: 365,
    smartAdIncludedTotal: 0,
    smartAdDays: 0,
    rocketIncludedTotal: 14,
    rocketDays: 14,
    hasAiAssistant: true,
    hasLiveSupport: true,
  },
};

export const ALL_PRODUCTS = new Set<string>([
  ...Object.keys(PREMIUM_PRODUCTS),
  'normal_listing_5_399',
  'doping_7_189',
  'doping_14_249',
  'doping_28_359',
  'smart_ads_1_189',
  'smart_ads_7_899',
  'smart_ads_14_1499',
  'smart_ads_28_2999',
]);

export const asString = (v: unknown): string => String(v ?? '').trim();
export const lower = (v: unknown): string => asString(v).toLowerCase();

export const normalizeProvider = (platform: string): Provider | null => {
  const p = lower(platform);
  if (
    p.includes('google') ||
    p.includes('play') ||
    p.includes('android') ||
    p.includes('play_store')
  ) {
    return 'google_play';
  }
  if (p.includes('apple') || p.includes('app_store') || p.includes('ios')) {
    return 'app_store';
  }
  return null;
};

export const nowIso = () => new Date().toISOString();

export const parseIso = (raw: unknown): Date | null => {
  const s = asString(raw);
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t);
};

export const parseBool = (v: string | undefined, fallback: boolean): boolean => {
  if (v == null) return fallback;
  const s = v.trim().toLowerCase();
  if (s === '1' || s === 'true' || s === 'yes' || s === 'on') return true;
  if (s === '0' || s === 'false' || s === 'no' || s === 'off') return false;
  return fallback;
};

export const parseJwtPayload = (jwt: string): Record<string, unknown> | null => {
  const raw = asString(jwt);
  if (!raw || !raw.includes('.')) return null;
  const parts = raw.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    return JSON.parse(payload) as Record<string, unknown>;
  } catch (_) {
    return null;
  }
};

export const statusFromGoogleNotificationType = (typeNo: number): PurchaseStatus => {
  switch (typeNo) {
    case 1:
    case 2:
    case 4:
    case 7:
      return 'verified';
    case 3:
      return 'canceled';
    case 5:
    case 6:
    case 10:
      return 'pending';
    case 12:
      return 'refunded';
    case 13:
      return 'expired';
    default:
      return 'pending';
  }
};

export const statusFromAppleNotificationType = (typeRaw: unknown): PurchaseStatus => {
  const t = lower(typeRaw);
  if (t.includes('expired')) return 'expired';
  if (t.includes('refund') || t.includes('revoke')) return 'refunded';
  if (t.includes('cancel')) return 'canceled';
  if (t.includes('renew') || t.includes('subscribed')) return 'verified';
  if (t.includes('grace') || t.includes('billing_retry')) return 'pending';
  return 'pending';
};

