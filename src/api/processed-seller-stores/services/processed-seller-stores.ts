const STORE_UID = 'api::seller-store.seller-store';

type Identity = {
  email: string;
  ownerId: string;
};

type StorePayload = {
  storeName: string;
  storeSlug: string;
  city: string;
  contactName: string;
  shortDescription: string;
  aboutText: string;
  logoPath: string;
  coverPath: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const asString = (value: unknown): string => String(value ?? '').trim();

const httpError = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

const getStorePayload = (body: unknown): StorePayload => {
  const root = isRecord(body) ? body : {};
  const nested = isRecord(root.store)
    ? root.store
    : isRecord(root.data)
      ? root.data
      : root;

  const storeName = asString(nested.storeName);
  const city = asString(nested.city);
  const contactName = asString(nested.contactName);
  const shortDescription = asString(nested.shortDescription);

  if (!storeName) throw httpError(400, 'storeName zorunlu.');
  if (!city) throw httpError(400, 'city zorunlu.');
  if (!contactName) throw httpError(400, 'contactName zorunlu.');
  if (!shortDescription) throw httpError(400, 'shortDescription zorunlu.');

  return {
    storeName,
    storeSlug: asString(nested.storeSlug),
    city,
    contactName,
    shortDescription,
    aboutText: asString(nested.aboutText),
    logoPath: asString(nested.logoPath),
    coverPath: asString(nested.coverPath),
  };
};

const mapStore = (entity: any) => {
  if (!entity || typeof entity !== 'object') return null;
  return {
    id: String(entity.id ?? ''),
    documentId: asString(entity.documentId),
    remoteId: String(entity.id ?? ''),
    ownerId: asString(entity.ownerId),
    ownerEmail: asString(entity.ownerEmail),
    storeName: asString(entity.storeName),
    storeSlug: asString(entity.storeSlug),
    city: asString(entity.city),
    contactName: asString(entity.contactName),
    shortDescription: asString(entity.shortDescription),
    aboutText: asString(entity.aboutText),
    logoPath: asString(entity.logoPath),
    coverPath: asString(entity.coverPath),
    verificationStatus: asString(entity.verificationStatus),
    verificationNote: asString(entity.verificationNote),
    createdAtIso: asString(entity.createdAt),
    updatedAtIso: asString(entity.updatedAt),
  };
};

const isCompleteStore = (store: any): boolean =>
  asString(store?.storeName).length > 0 &&
  asString(store?.city).length > 0 &&
  asString(store?.contactName).length > 0 &&
  asString(store?.shortDescription).length > 0;

const findStoreByOwner = async (strapi: any, identity: Identity) => {
  const byOwnerId = await strapi.db.query(STORE_UID).findOne({
    where: { ownerId: identity.ownerId },
    select: [
      'id',
      'documentId',
      'ownerId',
      'ownerEmail',
      'storeName',
      'storeSlug',
      'city',
      'contactName',
      'shortDescription',
      'aboutText',
      'logoPath',
      'coverPath',
      'verificationStatus',
      'verificationNote',
      'createdAt',
      'updatedAt',
    ],
  } as any);
  if (byOwnerId) return byOwnerId;

  if (!identity.email) return null;
  return strapi.db.query(STORE_UID).findOne({
    where: { ownerEmail: identity.email },
    select: [
      'id',
      'documentId',
      'ownerId',
      'ownerEmail',
      'storeName',
      'storeSlug',
      'city',
      'contactName',
      'shortDescription',
      'aboutText',
      'logoPath',
      'coverPath',
      'verificationStatus',
      'verificationNote',
      'createdAt',
      'updatedAt',
    ],
  } as any);
};

export default ({ strapi }: { strapi: any }) => ({
  async getMine({ identity }: { identity: Identity }) {
    const found = await findStoreByOwner(strapi, identity);
    return mapStore(found);
  },

  async listPublic() {
    const rows = await strapi.db.query(STORE_UID).findMany({
      select: [
        'id',
        'documentId',
        'ownerId',
        'ownerEmail',
        'storeName',
        'storeSlug',
        'city',
        'contactName',
        'shortDescription',
        'aboutText',
        'logoPath',
        'coverPath',
        'verificationStatus',
        'verificationNote',
        'createdAt',
        'updatedAt',
      ],
      orderBy: { updatedAt: 'desc' },
    } as any);

    const list = Array.isArray(rows) ? rows : [];
    return list.filter(isCompleteStore).map(mapStore).filter(Boolean);
  },

  async upsert({ body, identity }: { body: unknown; identity: Identity }) {
    const payload = getStorePayload(body);
    const existing = await findStoreByOwner(strapi, identity);
    const data = {
      ownerId: identity.ownerId,
      ownerEmail: identity.email,
      storeName: payload.storeName,
      storeSlug: payload.storeSlug || slugify(payload.storeName),
      city: payload.city,
      contactName: payload.contactName,
      shortDescription: payload.shortDescription,
      aboutText: payload.aboutText || null,
      logoPath: payload.logoPath || null,
      coverPath: payload.coverPath || null,
      verificationStatus: asString((existing as any)?.verificationStatus) || 'not_submitted',
      verificationNote: asString((existing as any)?.verificationNote) || null,
    };

    const entity = existing
      ? await strapi.entityService.update(STORE_UID as any, Number((existing as any).id), { data })
      : await strapi.entityService.create(STORE_UID as any, { data });

    return mapStore(entity);
  },
});
