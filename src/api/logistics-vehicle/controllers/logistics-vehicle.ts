import { factories } from '@strapi/strapi';

const VEHICLE_UID = 'api::logistics-vehicle.logistics-vehicle';

const toNumber = (value: unknown, fallback = 0): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const toLimit = (value: unknown, fallback = 300): number => {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(raw)));
};

const generatePublicNo = async (
  strapi: any,
  uid: string,
  field: string,
): Promise<string> => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const base = Date.now() + attempt;
    const value = String(base % 100000000).padStart(8, '0');
    const existing = await strapi.db.query(uid).findOne({
      where: { [field]: value },
      select: ['id'],
    } as any);
    if (!existing) return value;
  }
  return String(Date.now()).slice(-8);
};

const normalizePublicNo = (value: unknown): string =>
  String(value || '')
    .trim()
    .replace(/^#/, '')
    .replace(/^(YL|AR)/i, '');

const asData = (ctx: any): Record<string, any> => {
  const body = ctx.request.body || {};
  return body.data && typeof body.data === 'object' ? body.data : body;
};

const stripPrefixes = (raw: unknown): string[] => {
  const id = String(raw || '').trim();
  const out = new Set<string>([id]);
  for (const prefix of ['veh_', 'vehicle_', 'log_vehicle_', 'strapi_']) {
    if (id.startsWith(prefix)) out.add(id.slice(prefix.length));
  }
  return [...out].filter(Boolean);
};

const resolveVehicle = async (strapi: any, rawId: unknown) => {
  for (const candidate of stripPrefixes(rawId)) {
    const numeric = Number(candidate);
    if (Number.isInteger(numeric) && numeric > 0) {
      try {
        const row = await strapi.entityService.findOne(
          VEHICLE_UID as any,
          numeric as any,
        );
        if (row) return row;
      } catch (_) {}
    }
    for (const field of ['documentId', 'localId', 'vehicleNo']) {
      try {
        const rows = await strapi.entityService.findMany(VEHICLE_UID as any, {
          filters: { [field]: candidate },
          pagination: { limit: 1 },
        } as any);
        const row = Array.isArray(rows) ? rows[0] : rows;
        if (row) return row;
      } catch (_) {}
    }
  }
  return null;
};

const actorKeyFor = (user: any): string => {
  if (!user) return '';
  const profileId = String(
    user.profileId || user.ownerProfileId || user.id || '',
  ).trim();
  if (profileId) return `profile:${profileId}`;
  const email = String(user.email || '').trim().toLowerCase();
  return email ? `email:${email}` : '';
};

const isAdmin = (user: any): boolean => {
  const role = user && user.role ? user.role : {};
  const value = String(role.code || role.type || role.name || '')
    .trim()
    .toLowerCase();
  return (
    value === 'admin' ||
    value === 'super-admin' ||
    value === 'administrator' ||
    value.includes('admin')
  );
};

const canOwnVehicle = (user: any, vehicle: any): boolean => {
  if (!user || !vehicle) return false;
  if (isAdmin(user)) return true;
  const actor = actorKeyFor(user);
  const owner = String(vehicle.transporterKey || '').trim();
  const userId = String(user.id || '').trim();
  const profileId = String(
    user.profileId || user.ownerProfileId || '',
  ).trim();
  const userEmail = String(user.email || '').trim().toLowerCase();
  return (
    owner === actor ||
    owner === userId ||
    owner === `id:${userId}` ||
    owner === `profile:${userId}` ||
    (profileId &&
      (owner === profileId ||
        owner === `id:${profileId}` ||
        owner === `profile:${profileId}`)) ||
    (userEmail && owner === `email:${userEmail}`)
  );
};

const distanceKm = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
  const radiusKm = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return 2 * radiusKm * Math.asin(Math.sqrt(a));
};

export default factories.createCoreController(VEHICLE_UID as any, ({ strapi }) => ({
  async create(ctx) {
    const data = { ...asData(ctx) };
    data.vehicleNo = normalizePublicNo(data.vehicleNo);
    if (!data.vehicleNo) {
      data.vehicleNo = await generatePublicNo(strapi, VEHICLE_UID, 'vehicleNo');
    }
    const created = await strapi.entityService.create(VEHICLE_UID as any, {
      data,
      populate: { photo: true },
    } as any);
    ctx.body = { data: created };
  },

  async update(ctx) {
    const vehicle = await resolveVehicle(strapi, ctx.params.id);
    if (!vehicle) return ctx.notFound('Lojistik arac bulunamadi.');
    if (!canOwnVehicle(ctx.state.user, vehicle)) {
      return ctx.forbidden(
        'Bu arac ilanini sadece sahibi veya admin guncelleyebilir.',
      );
    }
    const data = { ...asData(ctx) };
    delete data.transporterKey;
    const updated = await strapi.entityService.update(
      VEHICLE_UID as any,
      vehicle.id as any,
      { data, populate: { photo: true } } as any,
    );
    ctx.body = { data: updated };
  },

  async delete(ctx) {
    const vehicle = await resolveVehicle(strapi, ctx.params.id);
    if (!vehicle) return ctx.notFound('Lojistik arac bulunamadi.');
    if (!canOwnVehicle(ctx.state.user, vehicle)) {
      return ctx.forbidden('Bu arac ilanini sadece sahibi veya admin silebilir.');
    }
    await strapi.entityService.delete(VEHICLE_UID as any, vehicle.id as any);
    ctx.body = { data: { id: vehicle.id, deleted: true } };
  },

  async nearby(ctx) {
    const lat = toNumber(ctx.query?.latitude);
    const lng = toNumber(ctx.query?.longitude);
    const km = toNumber(ctx.query?.km, 300);
    const limit = toLimit(ctx.query?.limit, 300);

    const rows = await strapi.entityService.findMany(VEHICLE_UID as any, {
      filters: { available: true },
      sort: { createdAt: 'desc' },
      pagination: { limit },
      populate: { photo: true },
    } as any);

    const data = (Array.isArray(rows) ? rows : []).filter((row: any) => {
      const rowLat = toNumber(row?.latitude);
      const rowLng = toNumber(row?.longitude);
      return distanceKm(lat, lng, rowLat, rowLng) <= km;
    });

    ctx.body = { data };
  },
}));

