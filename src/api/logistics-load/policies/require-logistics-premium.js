'use strict';

const LOGISTICS_MODULES = new Set([
  'logistics',
  'nakliye',
  'nakliyat',
]);

const toList = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') return Object.values(parsed);
    } catch (_) {
      return value.split(',');
    }
  }
  if (typeof value === 'object') return Object.values(value);
  return [];
};

const normalizeModule = (value) => {
  if (value == null) return '';
  if (typeof value === 'object') {
    return String(value.code || value.key || value.id || value.name || '')
      .trim()
      .toLowerCase();
  }
  return String(value).trim().toLowerCase();
};

const hasLogisticsModule = (profile) => {
  const modules = [
    ...toList(profile.activeModules),
    ...toList(profile.businessModules),
  ];
  return modules.some((item) => LOGISTICS_MODULES.has(normalizeModule(item)));
};

const premiumEndsAt = (premium) => {
  if (!premium || typeof premium !== 'object') return null;
  const raw = premium.endsAt || premium.endDate || premium.expiresAt;
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
};

const hasActivePremium = (profile) => {
  const direct = profile.activePremiumSubscription || profile.activePremium;
  if (direct && typeof direct === 'object') {
    const endsAt = premiumEndsAt(direct);
    if (endsAt) return endsAt.getTime() > Date.now();
    if (direct.active === true || direct.isActive === true) return true;
  }
  return false;
};

const findProfileForUser = async (strapi, user) => {
  const email = String(user.email || '').trim().toLowerCase();
  const rows = await strapi.entityService.findMany(
    'api::profile-setting.profile-setting',
    {
      filters: {
        $or: [
          { user: { id: user.id } },
          { ownerEmail: email },
          { profileId: String(user.id) },
        ],
      },
      limit: 1,
    },
  );
  return Array.isArray(rows) ? rows[0] : rows;
};

module.exports = async (policyContext, _config, { strapi }) => {
  const user = policyContext.state.user;
  if (!user) {
    return policyContext.unauthorized('Nakliye ilani acmak icin giris gerekli.');
  }

  const profile = await findProfileForUser(strapi, user);
  if (!profile || !hasActivePremium(profile) || !hasLogisticsModule(profile)) {
    return policyContext.forbidden(
      'Nakliye ilani acmak icin aktif Premium Lojistik modulu gerekir.',
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
