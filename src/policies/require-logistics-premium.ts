import { isPremiumActiveFromProfile } from '../utils/premium-sync';

const LOGISTICS_MODULES = new Set(['logistics', 'lojistik', 'nakliye', 'nakliyat']);

const toList = (value: unknown): unknown[] => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') return Object.values(parsed as Record<string, unknown>);
    } catch (_) {
      return value.split(',');
    }
  }
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>);
  return [];
};

const normalizeModule = (value: unknown): string => {
  if (value == null) return '';
  if (typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return String(row.code || row.key || row.id || row.name || '').trim().toLowerCase();
  }
  return String(value).trim().toLowerCase();
};

const hasLogisticsModule = (profile: any): boolean => {
  const modules = [...toList(profile?.activeModules), ...toList(profile?.businessModules)];
  return modules.some((item) => LOGISTICS_MODULES.has(normalizeModule(item)));
};

const isLogisticsModuleDisabled = (profile: any): boolean => {
  const disabledModules = toList(profile?.disabledBusinessModules);
  return disabledModules.some((item) => LOGISTICS_MODULES.has(normalizeModule(item)));
};

/**
 * SEMANTIC_CONTRACT_S1: delegates entirely to premium-sync.ts's canonical
 * rule (missing endsAt = active/unlimited) instead of a separate, stricter
 * local reimplementation (the old version returned false for a missing
 * endsAt, denying the Logistics module to exactly the members the
 * canonical rule considers active). See
 * SEMANTIC_CONTRACT_S1_CRITICAL_FIX_REPORT.md.
 */
const hasActivePremium = (profile: any): boolean =>
  isPremiumActiveFromProfile(profile);

const findProfileForUser = async (strapi: any, user: any) => {
  const email = String(user?.email || '').trim().toLowerCase();
  const rows = await strapi.entityService.findMany('api::profile-setting.profile-setting' as any, {
    filters: {
      $or: [
        { user: { id: user.id } },
        { ownerEmail: email },
        { profileId: String(user.id) },
      ],
    },
    pagination: { limit: 1 },
  } as any);
  return Array.isArray(rows) ? rows[0] : rows;
};

/**
 * SEMANTIC_CONTRACT_S1: `policyContext.unauthorized`/`.forbidden` are not
 * guaranteed to exist at the policy layer in this Strapi version -- the
 * same reason src/utils/identity.ts's denyNoIdentity/denyForbidden exist
 * (calling them directly crashed with a 500 "not a function" instead of
 * ever returning the intended 401/403; only discovered now because no
 * prior test exercised this policy's rejection path via a real HTTP
 * request -- existing tests bypass it entirely via entityService).
 */
const denyPolicy = (ctx: any, status: 401 | 403, message: string): false => {
  if (status === 401 && typeof ctx?.unauthorized === 'function') {
    ctx.unauthorized(message);
  } else if (status === 403 && typeof ctx?.forbidden === 'function') {
    ctx.forbidden(message);
  } else if (typeof ctx?.throw === 'function') {
    ctx.throw(status, message);
  } else {
    ctx.status = status;
    ctx.body = { error: { message } };
  }
  return false;
};

export default async (policyContext: any, _config: any, { strapi }: any) => {
  const user = policyContext.state.user;
  if (!user) {
    return denyPolicy(policyContext, 401, 'Nakliye ilani acmak icin giris gerekli.');
  }

  const profile = await findProfileForUser(strapi, user);
  if (!profile || !hasActivePremium(profile) || !hasLogisticsModule(profile)) {
    return denyPolicy(
      policyContext,
      403,
      'Nakliye ilani acmak icin aktif Premium Lojistik modulu gerekir.',
    );
  }

  if (isLogisticsModuleDisabled(profile)) {
    return denyPolicy(
      policyContext,
      403,
      'Nakliye ve Lojistik modulu hesabinda kapali. Modul Yonetimi sayfasindan tekrar acabilirsin.',
    );
  }

  const body = policyContext.request.body || {};
  const data = body.data && typeof body.data === 'object' ? body.data : body;
  data.ownerKey = profile.profileId || String(user.id);
  data.ownerName = profile.displayName || user.username || user.email || 'Yuk Sahibi';
  if (profile.phone && !data.ownerPhone) data.ownerPhone = profile.phone;
  if (profile.whatsapp && !data.ownerWhatsapp) data.ownerWhatsapp = profile.whatsapp;
  data.viewCount = 0;
  data.likeCount = 0;
  data.favoriteCount = 0;
  data.likedActorKeys = [];
  data.favoriteActorKeys = [];

  if (body.data && typeof body.data === 'object') {
    policyContext.request.body.data = data;
  } else {
    policyContext.request.body = data;
  }

  return true;
};
