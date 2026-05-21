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

const premiumEndsAt = (premium: any): Date | null => {
  if (!premium || typeof premium !== 'object') return null;
  const raw = premium.endsAt || premium.endDate || premium.expiresAt;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
};

const hasActivePremium = (profile: any): boolean => {
  const direct = profile?.activePremiumSubscription || profile?.activePremium;
  if (direct && typeof direct === 'object') {
    const endsAt = premiumEndsAt(direct);
    if (endsAt) return endsAt.getTime() > Date.now();
    if (direct.active === true || direct.isActive === true) return true;
  }
  return false;
};

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

export default async (policyContext: any, _config: any, { strapi }: any) => {
  const user = policyContext.state.user;
  if (!user) {
    return policyContext.unauthorized('Nakliye ilani acmak icin giris gerekli.');
  }

  const profile = await findProfileForUser(strapi, user);
  if (!profile || !hasActivePremium(profile) || !hasLogisticsModule(profile)) {
    return policyContext.forbidden('Nakliye ilani acmak icin aktif Premium Lojistik modulu gerekir.');
  }

  if (isLogisticsModuleDisabled(profile)) {
    return policyContext.forbidden('Nakliye ve Lojistik modulu hesabinda kapali. Modul Yonetimi sayfasindan tekrar acabilirsin.');
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
