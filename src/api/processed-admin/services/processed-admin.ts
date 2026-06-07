const USER_UID = 'plugin::users-permissions.user';
const STORE_UID = 'api::seller-store.seller-store';
const DOCUMENT_UID = 'api::store-document.store-document';
const PRODUCT_UID = 'api::processed-product.processed-product';

const ALLOWED_STORE_STATUSES = new Set(['pending', 'approved', 'rejected']);
const ALLOWED_PRODUCT_STATUSES = new Set(['pending', 'approved', 'rejected']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const asString = (value: unknown): string => String(value ?? '').trim();

const asNumber = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = asString(value).replace(',', '.');
  if (!raw) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
};

const normalizeStatus = (value: unknown, allowed: Set<string>): string => {
  const raw = asString(value).toLowerCase();
  return allowed.has(raw) ? raw : '';
};

const normalizeEmail = (value: unknown): string =>
  asString(value).toLowerCase();

const httpError = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });

const parseAdminAllowlist = (): Set<string> => {
  const raw = asString(process.env.PROCESSED_MARKETPLACE_ADMIN_EMAILS);
  if (!raw) return new Set<string>();
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0),
  );
};

const adminAllowlist = parseAdminAllowlist();

const parseStock = (stockText: string): number => {
  const digits = stockText.match(/\d+/)?.[0] ?? '';
  const value = Number.parseInt(digits, 10);
  return Number.isInteger(value) ? value : 0;
};

const loadAdminUser = async (strapi: any, authUserId: number) => {
  const user = await strapi.entityService.findOne(USER_UID as any, authUserId as any, {
    fields: ['id', 'email', 'username'],
    populate: {
      role: {
        fields: ['id', 'name', 'type'],
      },
    },
  });
  if (!user || typeof user !== 'object') {
    throw httpError(401, 'Admin oturumu okunamadi.');
  }

  const email = normalizeEmail((user as any).email);
  const username = normalizeEmail((user as any).username);
  const roleType = normalizeEmail((user as any)?.role?.type);
  const roleName = normalizeEmail((user as any)?.role?.name);
  const roleBasedAdmin =
    roleType === 'admin' ||
    roleType === 'super-admin' ||
    roleName.includes('admin') ||
    roleName.includes('yonetici');
  const allowlistAdmin =
    (email && adminAllowlist.has(email)) ||
    (username && adminAllowlist.has(username));

  if (!roleBasedAdmin && !allowlistAdmin) {
    throw httpError(
      403,
      'Bu endpoint yalnizca islenmis urunler admin oturumlarina aciktir.',
    );
  }

  return {
    id: authUserId,
    email,
    username,
    roleType,
    roleName,
    accessMode: roleBasedAdmin ? 'role' : 'allowlist',
  };
};

const mapDocument = (entity: any) => ({
  remoteId: String(entity?.id ?? ''),
  localDocumentId: asString(entity?.localDocumentId),
  documentType: asString(entity?.documentType),
  title: asString(entity?.title),
  filePath: asString(entity?.filePath),
  verificationStatus: asString(entity?.verificationStatus),
  reviewNote: asString(entity?.reviewNote),
});

const mapStore = (entity: any) => ({
  remoteId: String(entity?.id ?? ''),
  ownerId: asString(entity?.ownerId),
  ownerEmail: asString(entity?.ownerEmail),
  storeName: asString(entity?.storeName),
  storeSlug: asString(entity?.storeSlug),
  city: asString(entity?.city),
  contactName: asString(entity?.contactName),
  shortDescription: asString(entity?.shortDescription),
  aboutText: asString(entity?.aboutText),
  verificationStatus: asString(entity?.verificationStatus || 'not_submitted'),
  verificationNote: asString(entity?.verificationNote),
  updatedAtIso: asString(entity?.updatedAt),
  documents: Array.isArray(entity?.documents)
    ? entity.documents.map(mapDocument)
    : [],
});

const mapProduct = (entity: any) => ({
  remoteId: String(entity?.id ?? ''),
  localProductId: asString(entity?.localProductId),
  ownerId: asString(entity?.ownerId),
  ownerEmail: asString(entity?.ownerEmail),
  storeSlug: asString(entity?.storeSlug),
  storeName: asString(entity?.storeName),
  city: asString(entity?.city),
  title: asString(entity?.title),
  category: asString(entity?.category),
  packageText: asString(entity?.packageText),
  unitText: asString(entity?.unitText),
  priceText: asString(entity?.priceText),
  stockText: asString(entity?.stockText),
  shortDescription: asString(entity?.shortDescription),
  coverPath: asString(entity?.coverPath),
  isActive: entity?.isActive === true,
  moderationStatus: asString(entity?.moderationStatus || 'approved'),
  moderationNote: asString(entity?.moderationNote),
  updatedAtIso: asString(entity?.updatedAt),
});

const loadStoreByAnyId = async (strapi: any, rawId: unknown) => {
  const id = asString(rawId);
  if (!id) throw httpError(400, 'storeId zorunlu.');
  const numericId = Number(id);
  if (Number.isInteger(numericId) && numericId > 0) {
    const byNumeric = await strapi.entityService.findOne(STORE_UID as any, numericId as any, {
      fields: [
        'id',
        'ownerId',
        'ownerEmail',
        'storeName',
        'storeSlug',
        'city',
        'contactName',
        'shortDescription',
        'aboutText',
        'verificationStatus',
        'verificationNote',
        'updatedAt',
      ],
      populate: {
        documents: {
          fields: [
            'id',
            'localDocumentId',
            'documentType',
            'title',
            'filePath',
            'verificationStatus',
            'reviewNote',
          ],
        },
      },
    });
    if (byNumeric) return byNumeric;
  }
  const byDocumentId = await strapi.db.query(STORE_UID).findOne({
    where: { documentId: id },
    populate: {
      documents: {
        select: [
          'id',
          'localDocumentId',
          'documentType',
          'title',
          'filePath',
          'verificationStatus',
          'reviewNote',
        ],
      },
    },
    select: [
      'id',
      'ownerId',
      'ownerEmail',
      'storeName',
      'storeSlug',
      'city',
      'contactName',
      'shortDescription',
      'aboutText',
      'verificationStatus',
      'verificationNote',
      'updatedAt',
    ],
  } as any);
  if (!byDocumentId) throw httpError(404, 'Magaza bulunamadi.');
  return byDocumentId;
};

const loadProductByAnyId = async (strapi: any, rawId: unknown) => {
  const id = asString(rawId);
  if (!id) throw httpError(400, 'productId zorunlu.');
  const numericId = Number(id);
  if (Number.isInteger(numericId) && numericId > 0) {
    const byNumeric = await strapi.entityService.findOne(PRODUCT_UID as any, numericId as any, {
      fields: [
        'id',
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
        'moderationStatus',
        'moderationNote',
        'updatedAt',
      ],
    });
    if (byNumeric) return byNumeric;
  }
  const byDocumentId = await strapi.db.query(PRODUCT_UID).findOne({
    where: { documentId: id },
    select: [
      'id',
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
      'moderationStatus',
      'moderationNote',
      'updatedAt',
    ],
  } as any);
  if (!byDocumentId) throw httpError(404, 'Urun bulunamadi.');
  return byDocumentId;
};

export default ({ strapi }: { strapi: any }) => ({
  async getAccess({ authUserId }: { authUserId: number }) {
    const adminUser = await loadAdminUser(strapi, authUserId);
    return {
      isAdmin: true,
      email: adminUser.email,
      roleType: adminUser.roleType,
      roleName: adminUser.roleName,
      accessMode: adminUser.accessMode,
    };
  },

  async listStores({ authUserId }: { authUserId: number }) {
    await loadAdminUser(strapi, authUserId);
    const entities = await strapi.entityService.findMany(STORE_UID as any, {
      fields: [
        'id',
        'ownerId',
        'ownerEmail',
        'storeName',
        'storeSlug',
        'city',
        'contactName',
        'shortDescription',
        'aboutText',
        'verificationStatus',
        'verificationNote',
        'updatedAt',
      ],
      populate: {
        documents: {
          fields: [
            'id',
            'localDocumentId',
            'documentType',
            'title',
            'filePath',
            'verificationStatus',
            'reviewNote',
          ],
        },
      },
      sort: ['updatedAt:desc'],
    });
    const rows = Array.isArray(entities) ? entities : [];
    return rows.map(mapStore);
  },

  async reviewStore({ authUserId, body }: { authUserId: number; body: unknown }) {
    await loadAdminUser(strapi, authUserId);
    const root = isRecord(body) ? body : {};
    const status = normalizeStatus(root.status, ALLOWED_STORE_STATUSES);
    const note = asString(root.note);
    if (!status) throw httpError(400, 'status gecersiz.');

    const store = await loadStoreByAnyId(strapi, root.storeId ?? root.remoteId ?? root.id);
    const storeId = Number((store as any)?.id ?? 0);
    if (!storeId) throw httpError(500, 'Magaza id bilgisi okunamadi.');

    await strapi.entityService.update(STORE_UID as any, storeId, {
      data: {
        verificationStatus: status,
        verificationNote: note || null,
      },
    });

    const documents = Array.isArray((store as any)?.documents) ? (store as any).documents : [];
    for (const doc of documents) {
      const docId = Number((doc as any)?.id ?? 0);
      if (!docId) continue;
      await strapi.entityService.update(DOCUMENT_UID as any, docId, {
        data: {
          verificationStatus: status,
          reviewNote: note || null,
        },
      });
    }

    const updated = await loadStoreByAnyId(strapi, storeId);
    return mapStore(updated);
  },

  async listProducts({ authUserId }: { authUserId: number }) {
    await loadAdminUser(strapi, authUserId);
    const entities = await strapi.entityService.findMany(PRODUCT_UID as any, {
      fields: [
        'id',
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
        'moderationStatus',
        'moderationNote',
        'updatedAt',
      ],
      sort: ['updatedAt:desc'],
    });
    const rows = Array.isArray(entities) ? entities : [];
    return rows.map(mapProduct);
  },

  async reviewProduct({ authUserId, body }: { authUserId: number; body: unknown }) {
    await loadAdminUser(strapi, authUserId);
    const root = isRecord(body) ? body : {};
    const status = normalizeStatus(root.status, ALLOWED_PRODUCT_STATUSES);
    const note = asString(root.note);
    if (!status) throw httpError(400, 'status gecersiz.');

    const product = await loadProductByAnyId(strapi, root.productId ?? root.remoteId ?? root.id);
    const productId = Number((product as any)?.id ?? 0);
    if (!productId) throw httpError(500, 'Urun id bilgisi okunamadi.');

    const stockText = asString((product as any)?.stockText);
    const currentActive = (product as any)?.isActive === true;
    const nextActive = status === 'rejected' ? false : (currentActive && parseStock(stockText) > 0);

    await strapi.entityService.update(PRODUCT_UID as any, productId, {
      data: {
        moderationStatus: status,
        moderationNote: note || null,
        isActive: nextActive,
      },
    });

    const updated = await loadProductByAnyId(strapi, productId);
    return mapProduct(updated);
  },

});
