const PRODUCT_UID = 'api::processed-product.processed-product';
const STORE_UID = 'api::seller-store.seller-store';

type Identity = {
  email: string;
  ownerId: string;
};

type ProductPayload = {
  localProductId: string;
  title: string;
  category: string;
  packageText: string;
  unitText: string;
  priceText: string;
  stockText: string;
  shortDescription: string;
  coverPath: string;
  isActive: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const asString = (value: unknown): string => String(value ?? '').trim();

const asBool = (value: unknown, fallback = false): boolean => {
  if (typeof value === 'boolean') return value;
  const raw = asString(value).toLowerCase();
  if (!raw) return fallback;
  return raw == 'true' || raw == '1' || raw == 'yes';
};

const httpError = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });

const getProductPayload = (body: unknown): ProductPayload => {
  const root = isRecord(body) ? body : {};
  const nested = isRecord(root.product)
    ? root.product
    : isRecord(root.data)
      ? root.data
      : root;

  const localProductId = asString(
    nested.localProductId ?? nested.id ?? root.localProductId ?? root.id,
  );
  const title = asString(nested.title);
  const category = asString(nested.category);

  if (!localProductId) throw httpError(400, 'localProductId zorunlu.');
  if (!title) throw httpError(400, 'title zorunlu.');
  if (!category) throw httpError(400, 'category zorunlu.');

  return {
    localProductId,
    title,
    category,
    packageText: asString(nested.packageText),
    unitText: asString(nested.unitText),
    priceText: asString(nested.priceText),
    stockText: asString(nested.stockText),
    shortDescription: asString(nested.shortDescription),
    coverPath: asString(nested.coverPath),
    isActive: asBool(nested.isActive, true),
  };
};

const mapProduct = (entity: any) => {
  if (!entity || typeof entity !== 'object') return null;
  return {
    id: asString(entity.localProductId),
    localProductId: asString(entity.localProductId),
    remoteId: String(entity.id ?? ''),
    documentId: asString(entity.documentId),
    ownerId: asString(entity.ownerId),
    ownerEmail: asString(entity.ownerEmail),
    storeSlug: asString(entity.storeSlug),
    storeName: asString(entity.storeName),
    city: asString(entity.city),
    title: asString(entity.title),
    category: asString(entity.category),
    packageText: asString(entity.packageText),
    unitText: asString(entity.unitText),
    priceText: asString(entity.priceText),
    stockText: asString(entity.stockText),
    shortDescription: asString(entity.shortDescription),
    coverPath: asString(entity.coverPath),
    isActive: Boolean(entity.isActive),
    sortOrder: typeof entity.sortOrder === 'number' ? entity.sortOrder : 0,
    createdAtIso: asString(entity.createdAt),
    updatedAtIso: asString(entity.updatedAt),
  };
};

const sortByUpdatedDesc = (list: any[]) =>
  list.sort((a, b) => {
    const at = Date.parse(asString(a?.updatedAt) || asString(a?.createdAt) || '1970-01-01');
    const bt = Date.parse(asString(b?.updatedAt) || asString(b?.createdAt) || '1970-01-01');
    return bt - at;
  });

const findStoreByOwner = async (strapi: any, identity: Identity) => {
  const found = await strapi.db.query(STORE_UID).findOne({
    where: { ownerId: identity.ownerId },
    select: ['id', 'ownerId', 'ownerEmail', 'storeSlug', 'storeName', 'city'],
  } as any);
  if (found) return found;
  if (!identity.email) return null;
  return strapi.db.query(STORE_UID).findOne({
    where: { ownerEmail: identity.email },
    select: ['id', 'ownerId', 'ownerEmail', 'storeSlug', 'storeName', 'city'],
  } as any);
};

const findOwnedProduct = async (
  strapi: any,
  identity: Identity,
  localProductId: string,
) => {
  return strapi.db.query(PRODUCT_UID).findOne({
    where: {
      localProductId,
      ownerId: identity.ownerId,
    },
    select: [
      'id',
      'documentId',
      'localProductId',
      'ownerId',
      'ownerEmail',
      'storeSlug',
      'storeName',
      'city',
      'title',
      'category',
      'packageText',
      'unitText',
      'priceText',
      'stockText',
      'shortDescription',
      'coverPath',
      'isActive',
      'sortOrder',
      'createdAt',
      'updatedAt',
    ],
  } as any);
};

const findProductByRemoteId = async (strapi: any, remoteId: unknown) => {
  const raw = asString(remoteId);
  if (!raw) return null;
  const numeric = Number(raw);
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  try {
    return await strapi.entityService.findOne(PRODUCT_UID as any, numeric as any, {
      fields: [
        'id',
        'documentId',
        'localProductId',
        'ownerId',
        'ownerEmail',
        'storeSlug',
        'storeName',
        'city',
        'title',
        'category',
        'packageText',
        'unitText',
        'priceText',
        'stockText',
        'shortDescription',
        'coverPath',
        'isActive',
        'createdAt',
        'updatedAt',
      ],
      populate: ['store'],
    });
  } catch (_) {
    return null;
  }
};

export default ({ strapi }: { strapi: any }) => ({
  async getMine({ identity }: { identity: Identity }) {
    const rows = await strapi.db.query(PRODUCT_UID).findMany({
      where: { ownerId: identity.ownerId },
      select: [
        'id',
        'documentId',
        'localProductId',
        'ownerId',
        'ownerEmail',
        'storeSlug',
        'storeName',
        'city',
        'title',
        'category',
        'packageText',
        'unitText',
        'priceText',
        'stockText',
        'shortDescription',
        'coverPath',
        'isActive',
        'createdAt',
        'updatedAt',
      ],
      orderBy: { updatedAt: 'desc' },
    } as any);

    const list = Array.isArray(rows) ? rows : [];
    return sortByUpdatedDesc(list).map(mapProduct).filter(Boolean);
  },

  async listPublic() {
    const rows = await strapi.db.query(PRODUCT_UID).findMany({
      where: { isActive: true },
      select: [
        'id',
        'documentId',
        'localProductId',
        'ownerId',
        'ownerEmail',
        'storeSlug',
        'storeName',
        'city',
        'title',
        'category',
        'packageText',
        'unitText',
        'priceText',
        'stockText',
        'shortDescription',
        'coverPath',
        'isActive',
        'createdAt',
        'updatedAt',
      ],
      orderBy: { updatedAt: 'desc' },
    } as any);

    const list = Array.isArray(rows) ? rows : [];
    return sortByUpdatedDesc(list).map(mapProduct).filter(Boolean);
  },

  async upsert({ body, identity }: { body: unknown; identity: Identity }) {
    const payload = getProductPayload(body);
    const store = await findStoreByOwner(strapi, identity);
    if (!store) {
      throw httpError(400, 'Once magaza profili olusturulmalidir.');
    }

    const existing = await findOwnedProduct(strapi, identity, payload.localProductId);

    const data = {
      localProductId: payload.localProductId,
      ownerId: identity.ownerId,
      ownerEmail: identity.email,
      store: Number((store as any).id),
      storeSlug: asString((store as any).storeSlug),
      storeName: asString((store as any).storeName),
      city: asString((store as any).city),
      title: payload.title,
      category: payload.category,
      packageText: payload.packageText || null,
      unitText: payload.unitText || null,
      priceText: payload.priceText || null,
      stockText: payload.stockText || null,
      shortDescription: payload.shortDescription || null,
      coverPath: payload.coverPath || null,
      isActive: payload.isActive,
      sortOrder: typeof (payload as any).sortOrder === 'number' ? (payload as any).sortOrder : 0,
    };

    const entity = existing
      ? await strapi.entityService.update(PRODUCT_UID as any, Number((existing as any).id), { data })
      : await strapi.entityService.create(PRODUCT_UID as any, { data });

    return mapProduct(entity);
  },

  async deleteOwned({ body, identity }: { body: unknown; identity: Identity }) {
    const root = isRecord(body) ? body : {};
    const localProductId = asString(root.localProductId ?? root.id);
    const remoteId = asString(root.remoteId ?? root.productId);

    let target = null as any;
    if (localProductId) {
      target = await findOwnedProduct(strapi, identity, localProductId);
    }
    if (!target && remoteId) {
      target = await findProductByRemoteId(strapi, remoteId);
      if (target && asString((target as any).ownerId) !== identity.ownerId) {
        throw httpError(403, 'Bu urunu silme yetkiniz yok.');
      }
    }

    if (!target) {
      throw httpError(404, 'Urun bulunamadi.');
    }

    const targetId = Number((target as any).id ?? 0);
    if (!targetId) {
      throw httpError(500, 'Urun id bilgisi okunamadi.');
    }

    await strapi.entityService.delete(PRODUCT_UID as any, targetId);
    return {
      id: asString((target as any).localProductId),
      remoteId: String((target as any).id ?? ''),
    };
  },
});
