import { factories } from '@strapi/strapi';

const UID = 'api::logistics-load.logistics-load';

const toNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.replace(',', '.').trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
};

const toInt = (value: unknown, fallback = 0): number => {
  const parsed = Math.trunc(toNumber(value, fallback));
  return parsed < 0 ? 0 : parsed;
};

const toLimit = (value: unknown, fallback = 300): number => {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return fallback;
  return Math.max(1, Math.min(500, Math.trunc(raw)));
};

const asData = (ctx: any): Record<string, any> => {
  const body = ctx.request.body || {};
  return body.data && typeof body.data === 'object' ? body.data : body;
};

const generatePublicNo = async (
  strapi: any,
  uid: string,
  field: string,
  prefix: string,
): Promise<string> => {
  for (let attempt = 0; attempt < 5; attempt++) {
    const base = Date.now() + attempt;
    const value = `${prefix}${String(base % 100000000).padStart(8, '0')}`;
    const existing = await strapi.db.query(uid).findOne({
      where: { [field]: value },
      select: ['id'],
    } as any);
    if (!existing) return value;
  }
  return `${prefix}${String(Date.now()).slice(-8)}`;
};

const stripPrefixes = (raw: unknown): string[] => {
  const id = String(raw || '').trim();
  const out = new Set<string>([id]);
  for (const prefix of ['load_', 'log_load_', 'strapi_']) {
    if (id.startsWith(prefix)) out.add(id.slice(prefix.length));
  }
  return [...out].filter(Boolean);
};

const resolveLoad = async (strapi: any, rawId: unknown) => {
  for (const candidate of stripPrefixes(rawId)) {
    const numeric = Number(candidate);
    if (Number.isInteger(numeric) && numeric > 0) {
      try {
        const row = await strapi.entityService.findOne(UID as any, numeric as any);
        if (row) return row;
      } catch (_) {}
    }
    for (const field of ['documentId', 'localId', 'loadNo']) {
      try {
        const rows = await strapi.entityService.findMany(UID as any, {
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
  const profileId = String(user.profileId || user.ownerProfileId || user.id || '').trim();
  if (profileId) return `profile:${profileId}`;
  const email = String(user.email || '').trim().toLowerCase();
  return email ? `email:${email}` : '';
};

const isAdmin = (user: any): boolean => {
  const role = user && user.role ? user.role : {};
  const value = String(role.code || role.type || role.name || '').trim().toLowerCase();
  return value === 'admin' || value === 'super-admin' || value === 'administrator' || value.includes('admin');
};

const canOwnLoad = (user: any, load: any): boolean => {
  if (!user || !load) return false;
  if (isAdmin(user)) return true;
  const actor = actorKeyFor(user);
  const loadOwner = String(load.ownerKey || '').trim();
  const userId = String(user.id || '').trim();
  const userEmail = String(user.email || '').trim().toLowerCase();
  return (
    loadOwner === actor ||
    loadOwner === userId ||
    loadOwner === `profile:${userId}` ||
    (userEmail && loadOwner === `email:${userEmail}`)
  );
};

const actorList = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).map(String).filter(Boolean);
  return [];
};

const metricBody = (load: any) => ({
  id: load.id,
  documentId: load.documentId,
  viewCount: toInt(load.viewCount),
  likeCount: toInt(load.likeCount),
  favoriteCount: toInt(load.favoriteCount),
});

const createMetricUpdater = (strapi: any, metric: 'view' | 'like' | 'favorite') => async (ctx: any) => {
  const load = await resolveLoad(strapi, ctx.params.id);
  if (!load) return ctx.notFound('Lojistik yuk bulunamadi.');

  const data = asData(ctx);
  const patch: Record<string, any> = {};

  if (metric === 'view') {
    const current = toInt(load.viewCount);
    const client = toInt(data.viewCount, current + 1);
    patch.viewCount = Math.max(current + 1, client);
  } else {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized('Bu islem icin giris gerekli.');
    const actor = actorKeyFor(user);
    if (!actor) return ctx.forbidden('Kullanici kimligi okunamadi.');
    const active = data.active !== false;
    const field = metric === 'like' ? 'likedActorKeys' : 'favoriteActorKeys';
    const countField = metric === 'like' ? 'likeCount' : 'favoriteCount';
    const actors = new Set(actorList(load[field]));
    if (active) actors.add(actor);
    else actors.delete(actor);
    patch[field] = [...actors];
    patch[countField] = actors.size;
  }

  const updated = await strapi.entityService.update(UID as any, load.id as any, { data: patch } as any);
  ctx.body = { data: metricBody(updated) };
};

const sanitizeCreateData = (data: Record<string, any>): Record<string, any> => {
  const next = { ...data };
  next.viewCount = 0;
  next.likeCount = 0;
  next.favoriteCount = 0;
  next.likedActorKeys = [];
  next.favoriteActorKeys = [];
  if (!next.status) next.status = 'open';
  return next;
};

const sanitizeOwnerUpdateData = (data: Record<string, any>, admin: boolean): Record<string, any> => {
  const allowed = new Set([
    'title',
    'loadType',
    'fromCity',
    'toCity',
    'weight',
    'vehicleType',
    'loadingDate',
    'latitude',
    'longitude',
    'fromLatitude',
    'fromLongitude',
    'toLatitude',
    'toLongitude',
    'description',
    'status',
    'ownerPhone',
    'ownerWhatsapp',
    'estimatedDuration',
    'loadNo',
  ]);
  if (admin) {
    allowed.add('ownerVerified');
    allowed.add('moderationStatus');
    allowed.add('moderationNote');
    allowed.add('adminStatus');
    allowed.add('adminNote');
  }
  const next: Record<string, any> = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (allowed.has(key)) next[key] = value;
  }
  return next;
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

export default factories.createCoreController(UID as any, ({ strapi }) => ({
  async create(ctx) {
    const data = sanitizeCreateData(asData(ctx));
    if (!String(data.loadNo || '').trim()) {
      data.loadNo = await generatePublicNo(strapi, UID, 'loadNo', 'YL');
    }
    const created = await strapi.entityService.create(UID as any, { data } as any);
    ctx.body = { data: created };
  },

  async update(ctx) {
    const load = await resolveLoad(strapi, ctx.params.id);
    if (!load) return ctx.notFound('Lojistik yuk bulunamadi.');
    const user = ctx.state.user;
    if (!canOwnLoad(user, load)) {
      return ctx.forbidden('Bu yuk ilanini sadece sahibi veya admin guncelleyebilir.');
    }
    const updated = await strapi.entityService.update(UID as any, load.id as any, {
      data: sanitizeOwnerUpdateData(asData(ctx), isAdmin(user)),
    } as any);
    ctx.body = { data: updated };
  },

  async delete(ctx) {
    const load = await resolveLoad(strapi, ctx.params.id);
    if (!load) return ctx.notFound('Lojistik yuk bulunamadi.');
    if (!canOwnLoad(ctx.state.user, load)) {
      return ctx.forbidden('Bu yuk ilanini sadece sahibi veya admin silebilir.');
    }
    await strapi.entityService.delete(UID as any, load.id as any);
    ctx.body = { data: { id: load.id, deleted: true } };
  },

  async metricView(ctx) {
    return createMetricUpdater(strapi, 'view')(ctx);
  },

  async metricLike(ctx) {
    return createMetricUpdater(strapi, 'like')(ctx);
  },

  async metricFavorite(ctx) {
    return createMetricUpdater(strapi, 'favorite')(ctx);
  },

  async nearby(ctx) {
    const lat = toNumber(ctx.query?.latitude);
    const lng = toNumber(ctx.query?.longitude);
    const km = toNumber(ctx.query?.km, 300);
    const limit = toLimit(ctx.query?.limit, 300);

    const rows = await strapi.entityService.findMany(UID as any, {
      filters: { status: { $ne: 'closed' } },
      sort: { createdAt: 'desc' },
      pagination: { limit },
    } as any);

    const data = (Array.isArray(rows) ? rows : [])
      .map((row: any) => {
        const rowLat = toNumber(row?.fromLatitude ?? row?.latitude);
        const rowLng = toNumber(row?.fromLongitude ?? row?.longitude);
        return { ...row, distanceKm: distanceKm(lat, lng, rowLat, rowLng) };
      })
      .filter((row: any) => row.distanceKm <= km)
      .sort((a: any, b: any) => a.distanceKm - b.distanceKm);

    ctx.body = { data };
  },
}));
