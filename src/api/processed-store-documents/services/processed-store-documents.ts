const STORE_UID = 'api::seller-store.seller-store';
const DOCUMENT_UID = 'api::store-document.store-document';

type Identity = {
  email: string;
  ownerId: string;
};

type DocumentPayload = {
  localDocumentId: string;
  documentType: string;
  title: string;
  filePath: string;
  fileId: number | null;
};

const ALLOWED_DOCUMENT_TYPES = new Set([
  'tax_certificate',
  'business_license',
  'production_certificate',
  'identity_document',
  'other',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const asString = (value: unknown): string => String(value ?? '').trim();

const asIntegerOrNull = (value: unknown): number | null => {
  const raw = Number.parseInt(asString(value), 10);
  return Number.isInteger(raw) && raw > 0 ? raw : null;
};

const httpError = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });

const readDocumentPayload = (body: unknown): DocumentPayload => {
  const root = isRecord(body) ? body : {};
  const nested = isRecord(root.document)
    ? root.document
    : isRecord(root.data)
      ? root.data
      : root;

  const localDocumentId = asString(
    nested.localDocumentId ?? nested.id ?? root.localDocumentId ?? root.id,
  );
  const documentType = asString(nested.documentType).toLowerCase();
  const title = asString(nested.title);
  const filePath = asString(nested.filePath);
  const fileId = asIntegerOrNull(nested.fileId ?? nested.file);

  if (!localDocumentId) throw httpError(400, 'localDocumentId zorunlu.');
  if (!ALLOWED_DOCUMENT_TYPES.has(documentType)) {
    throw httpError(400, 'documentType gecersiz.');
  }
  if (!title) throw httpError(400, 'title zorunlu.');
  if (!filePath && fileId == null) {
    throw httpError(400, 'Belge dosyasi gerekli.');
  }

  return {
    localDocumentId,
    documentType,
    title,
    filePath,
    fileId,
  };
};

const mapDocument = (entity: any) => {
  if (!entity || typeof entity !== 'object') return null;
  return {
    id: asString(entity.localDocumentId),
    localDocumentId: asString(entity.localDocumentId),
    remoteId: String(entity.id ?? ''),
    documentId: asString(entity.documentId),
    ownerId: asString(entity.ownerId),
    ownerEmail: asString(entity.ownerEmail),
    documentType: asString(entity.documentType),
    title: asString(entity.title),
    filePath: asString(entity.filePath),
    verificationStatus: asString(entity.verificationStatus),
    reviewNote: asString(entity.reviewNote),
    createdAtIso: asString(entity.createdAt),
    updatedAtIso: asString(entity.updatedAt),
  };
};

const findStoreByOwner = async (strapi: any, identity: Identity) => {
  const store = await strapi.db.query(STORE_UID).findOne({
    where: { ownerId: identity.ownerId },
    select: [
      'id',
      'ownerId',
      'ownerEmail',
      'verificationStatus',
      'verificationNote',
    ],
  } as any);
  if (store) return store;
  if (!identity.email) return null;
  return strapi.db.query(STORE_UID).findOne({
    where: { ownerEmail: identity.email },
    select: [
      'id',
      'ownerId',
      'ownerEmail',
      'verificationStatus',
      'verificationNote',
    ],
  } as any);
};

const setStoreVerificationState = async (
  strapi: any,
  storeId: number,
  status: 'not_submitted' | 'pending',
) => {
  await strapi.entityService.update(STORE_UID as any, storeId, {
    data: {
      verificationStatus: status,
      verificationNote: null,
    },
  });
};

const findOwnedDocument = async (
  strapi: any,
  identity: Identity,
  localDocumentId: string,
) => {
  return strapi.db.query(DOCUMENT_UID).findOne({
    where: {
      localDocumentId,
      ownerId: identity.ownerId,
    },
    select: [
      'id',
      'documentId',
      'localDocumentId',
      'ownerId',
      'ownerEmail',
      'documentType',
      'title',
      'filePath',
      'verificationStatus',
      'reviewNote',
      'createdAt',
      'updatedAt',
    ],
  } as any);
};

const findDocumentByRemoteId = async (strapi: any, remoteId: unknown) => {
  const raw = asString(remoteId);
  if (!raw) return null;
  const numeric = Number(raw);
  if (!Number.isInteger(numeric) || numeric <= 0) return null;
  try {
    return await strapi.entityService.findOne(DOCUMENT_UID as any, numeric as any, {
      fields: [
        'id',
        'documentId',
        'localDocumentId',
        'ownerId',
        'ownerEmail',
        'documentType',
        'title',
        'filePath',
        'verificationStatus',
        'reviewNote',
        'createdAt',
        'updatedAt',
      ],
      populate: ['file', 'store'],
    });
  } catch (_) {
    return null;
  }
};

export default ({ strapi }: { strapi: any }) => ({
  async getMine({ identity }: { identity: Identity }) {
    const rows = await strapi.db.query(DOCUMENT_UID).findMany({
      where: { ownerId: identity.ownerId },
      select: [
        'id',
        'documentId',
        'localDocumentId',
        'ownerId',
        'ownerEmail',
        'documentType',
        'title',
        'filePath',
        'verificationStatus',
        'reviewNote',
        'createdAt',
        'updatedAt',
      ],
      orderBy: { updatedAt: 'desc' },
    } as any);
    const list = Array.isArray(rows) ? rows : [];
    return list.map(mapDocument).filter(Boolean);
  },

  async createOwned({ body, identity }: { body: unknown; identity: Identity }) {
    const payload = readDocumentPayload(body);
    const store = await findStoreByOwner(strapi, identity);
    if (!store) {
      throw httpError(400, 'Once magaza profili olusturulmalidir.');
    }

    const existing = await findOwnedDocument(strapi, identity, payload.localDocumentId);
    const data = {
      store: Number((store as any).id),
      ownerId: identity.ownerId,
      ownerEmail: identity.email,
      localDocumentId: payload.localDocumentId,
      documentType: payload.documentType,
      title: payload.title,
      filePath: payload.filePath || null,
      file: payload.fileId,
      verificationStatus: 'pending',
      reviewNote: null,
    };

    const entity = existing
      ? await strapi.entityService.update(DOCUMENT_UID as any, Number((existing as any).id), { data })
      : await strapi.entityService.create(DOCUMENT_UID as any, { data });

    await setStoreVerificationState(strapi, Number((store as any).id), 'pending');
    return mapDocument(entity);
  },

  async deleteOwned({ body, identity }: { body: unknown; identity: Identity }) {
    const root = isRecord(body) ? body : {};
    const localDocumentId = asString(root.localDocumentId ?? root.id);
    const remoteId = asString(root.remoteId ?? root.documentId);
    const store = await findStoreByOwner(strapi, identity);
    if (!store) {
      throw httpError(404, 'Magaza bulunamadi.');
    }

    let target = null as any;
    if (localDocumentId) {
      target = await findOwnedDocument(strapi, identity, localDocumentId);
    }
    if (!target && remoteId) {
      target = await findDocumentByRemoteId(strapi, remoteId);
      if (target && asString((target as any).ownerId) !== identity.ownerId) {
        throw httpError(403, 'Bu belgeyi silme yetkiniz yok.');
      }
    }
    if (!target) {
      throw httpError(404, 'Belge bulunamadi.');
    }

    const targetId = Number((target as any).id ?? 0);
    if (!targetId) {
      throw httpError(500, 'Belge id bilgisi okunamadi.');
    }

    await strapi.entityService.delete(DOCUMENT_UID as any, targetId);

    const remaining = await strapi.db.query(DOCUMENT_UID).findMany({
      where: { ownerId: identity.ownerId },
      select: ['id'],
      limit: 1,
    } as any);
    await setStoreVerificationState(
      strapi,
      Number((store as any).id),
      Array.isArray(remaining) && remaining.length > 0 ? 'pending' : 'not_submitted',
    );

    return {
      id: asString((target as any).localDocumentId),
      remoteId: String((target as any).id ?? ''),
    };
  },
});
