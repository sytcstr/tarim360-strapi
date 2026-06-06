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
    } as any);
    ctx.body = { data: created };
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

