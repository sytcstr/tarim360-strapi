'use strict';

const LOAD_UID = 'api::logistics-load.logistics-load';
const VEHICLE_UID = 'api::logistics-vehicle.logistics-vehicle';
const OFFER_UID = 'api::logistics-offer.logistics-offer';

const asData = (ctx) => {
  const body = ctx.request.body || {};
  return body.data && typeof body.data === 'object' ? body.data : body;
};

const roleValue = (role) =>
  String((role && (role.code || role.type || role.name)) || '')
    .trim()
    .toLowerCase();

const isAdminUser = (user) => {
  if (!user) return false;
  const roles = Array.isArray(user.roles) ? user.roles : [user.role].filter(Boolean);
  return roles.some((role) => {
    const value = roleValue(role);
    return (
      value === 'admin' ||
      value === 'administrator' ||
      value === 'super-admin' ||
      value.includes('admin')
    );
  });
};

const assertAdmin = (ctx) => {
  if (!ctx.state.user) {
    ctx.unauthorized('Giris gerekli.');
    return false;
  }
  if (!isAdminUser(ctx.state.user)) {
    ctx.forbidden('Sadece admin erisebilir.');
    return false;
  }
  return true;
};

const cleanId = (raw) => String(raw || '').trim();

const idCandidates = (raw, prefixes) => {
  const id = cleanId(raw);
  const out = new Set([id]);
  for (const prefix of prefixes) {
    if (id.startsWith(prefix)) out.add(id.slice(prefix.length));
  }
  return [...out].filter(Boolean);
};

const resolveEntity = async (uid, rawId, prefixes = []) => {
  for (const candidate of idCandidates(rawId, prefixes)) {
    const numeric = Number(candidate);
    if (Number.isInteger(numeric) && numeric > 0) {
      try {
        const row = await strapi.entityService.findOne(uid, numeric);
        if (row) return row;
      } catch (_) {}
    }
    for (const field of ['documentId', 'localId', 'loadId', 'vehicleId', 'offerId', 'loadNo']) {
      try {
        const rows = await strapi.entityService.findMany(uid, {
          filters: { [field]: candidate },
          limit: 1,
        });
        const row = Array.isArray(rows) ? rows[0] : rows;
        if (row) return row;
      } catch (_) {}
    }
  }
  return null;
};

const oneOf = (value, allowed, fallback) => {
  const clean = cleanId(value).toLowerCase();
  return allowed.includes(clean) ? clean : fallback;
};

const listLatest = async (uid) =>
  strapi.entityService.findMany(uid, {
    sort: { updatedAt: 'desc' },
    limit: 300,
  });

module.exports = {
  async access(ctx) {
    if (!assertAdmin(ctx)) return;
    ctx.body = { isAdmin: true };
  },

  async loads(ctx) {
    if (!assertAdmin(ctx)) return;
    ctx.body = { loads: await listLatest(LOAD_UID) };
  },

  async loadReview(ctx) {
    if (!assertAdmin(ctx)) return;
    const data = asData(ctx);
    const load = await resolveEntity(LOAD_UID, data.loadId, ['load_', 'log_load_', 'strapi_']);
    if (!load) return ctx.notFound('Lojistik yuk bulunamadi.');
    const moderationStatus = oneOf(
      data.moderationStatus,
      ['approved', 'pending', 'rejected'],
      load.moderationStatus || 'pending',
    );
    const status = oneOf(data.status, ['open', 'offer_pending', 'meeting_opened', 'closed'], load.status || 'open');
    const updated = await strapi.entityService.update(LOAD_UID, load.id, {
      data: {
        moderationStatus,
        moderationNote: cleanId(data.note),
        adminStatus: moderationStatus,
        adminNote: cleanId(data.note),
        status,
      },
    });
    ctx.body = { load: updated };
  },

  async vehicles(ctx) {
    if (!assertAdmin(ctx)) return;
    ctx.body = { vehicles: await listLatest(VEHICLE_UID) };
  },

  async vehicleReview(ctx) {
    if (!assertAdmin(ctx)) return;
    const data = asData(ctx);
    const vehicle = await resolveEntity(VEHICLE_UID, data.vehicleId, [
      'veh_',
      'vehicle_',
      'log_vehicle_',
      'strapi_',
    ]);
    if (!vehicle) return ctx.notFound('Lojistik arac bulunamadi.');
    const moderationStatus = oneOf(
      data.moderationStatus,
      ['approved', 'pending', 'rejected'],
      vehicle.moderationStatus || 'pending',
    );
    const updated = await strapi.entityService.update(VEHICLE_UID, vehicle.id, {
      data: {
        moderationStatus,
        moderationNote: cleanId(data.note),
        adminStatus: moderationStatus,
        adminNote: cleanId(data.note),
        ...(typeof data.available === 'boolean' ? { available: data.available } : {}),
      },
    });
    ctx.body = { vehicle: updated };
  },

  async offers(ctx) {
    if (!assertAdmin(ctx)) return;
    ctx.body = { offers: await listLatest(OFFER_UID) };
  },

  async offerReview(ctx) {
    if (!assertAdmin(ctx)) return;
    const data = asData(ctx);
    const offer = await resolveEntity(OFFER_UID, data.offerId, ['offer_', 'log_offer_', 'strapi_']);
    if (!offer) return ctx.notFound('Lojistik teklif bulunamadi.');
    const issueStatus = oneOf(data.issueStatus, ['none', 'flagged', 'resolved'], offer.issueStatus || 'none');
    const status = oneOf(data.status, ['pending', 'accepted', 'rejected'], offer.status || 'pending');
    const updated = await strapi.entityService.update(OFFER_UID, offer.id, {
      data: {
        issueStatus,
        adminIssueStatus: issueStatus,
        adminNote: cleanId(data.note),
        status,
      },
    });
    ctx.body = { offer: updated };
  },
};
