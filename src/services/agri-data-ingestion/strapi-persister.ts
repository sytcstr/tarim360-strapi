import type { Core } from '@strapi/strapi';
import { normalizeLookupText, toAgriSlug } from './normalization';
import type {
  AgriPricePersister,
  PersistableAgriPriceRecord,
} from './types';

const PRODUCT_UID = 'api::agri-product.agri-product';
const PROVINCE_UID = 'api::province.province';
const OBSERVATION_UID =
  'api::agri-price-observation.agri-price-observation';

const findOrCreateProduct = async (
  strapi: Core.Strapi,
  record: PersistableAgriPriceRecord,
) => {
  const query = strapi.db.query(PRODUCT_UID as any);
  const slug = toAgriSlug(record.productName);
  const existing = await query.findOne({
    where: {
      $or: [{ slug }, { name: { $eqi: record.productName } }],
    },
  } as any);
  if (existing) return existing;

  try {
    return await query.create({
      data: {
        name: record.productName,
        slug,
        defaultUnit: record.unit,
        isActive: true,
        publishedAt: new Date().toISOString(),
      },
    } as any);
  } catch (error) {
    const concurrent = await query.findOne({ where: { slug } } as any);
    if (concurrent) return concurrent;
    throw error;
  }
};

const findOrCreateProvince = async (
  strapi: Core.Strapi,
  provinceName: string,
) => {
  if (!normalizeLookupText(provinceName)) return null;
  const query = strapi.db.query(PROVINCE_UID as any);
  const slug = toAgriSlug(provinceName);
  const existing = await query.findOne({
    where: {
      $or: [{ slug }, { name: { $eqi: provinceName } }],
    },
  } as any);
  if (existing) return existing;

  try {
    return await query.create({
      data: {
        name: provinceName,
        slug,
        isActive: true,
        publishedAt: new Date().toISOString(),
      },
    } as any);
  } catch (error) {
    const concurrent = await query.findOne({ where: { slug } } as any);
    if (concurrent) return concurrent;
    throw error;
  }
};

const calculateChangePercent = async (
  strapi: Core.Strapi,
  record: PersistableAgriPriceRecord,
  productId: number,
  provinceId: number | null,
): Promise<number | null> => {
  const where: Record<string, unknown> = {
    product: { id: productId },
    sourceName: record.sourceName,
    observedAt: { $lt: record.observedAt },
  };
  where.province = provinceId ? { id: provinceId } : { $null: true };
  const previous = await strapi.db.query(OBSERVATION_UID as any).findOne({
    where,
    orderBy: { observedAt: 'desc' },
  } as any);
  const previousPrice = Number(previous?.averagePrice ?? previous?.price);
  if (!Number.isFinite(previousPrice) || previousPrice <= 0) return null;
  return ((record.averagePrice - previousPrice) / previousPrice) * 100;
};

export const createStrapiAgriPricePersister = (
  strapi: Core.Strapi,
): AgriPricePersister => async (record) => {
  const query = strapi.db.query(OBSERVATION_UID as any);
  const existing = await query.findOne({
    where: { dedupeKey: record.dedupeKey },
  } as any);
  if (existing) return 'duplicate';

  const product = await findOrCreateProduct(strapi, record);
  const province = await findOrCreateProvince(strapi, record.provinceName);
  const changePercent = await calculateChangePercent(
    strapi,
    record,
    Number(product.id),
    province ? Number(province.id) : null,
  );

  try {
    await query.create({
      data: {
        product: product.id,
        province: province?.id ?? null,
        observedAt: record.observedAt,
        price: record.averagePrice,
        minPrice: record.minPrice,
        maxPrice: record.maxPrice,
        averagePrice: record.averagePrice,
        currency: record.currency,
        unit: record.unit,
        marketName: record.sourceName,
        sourceName: record.sourceName,
        sourceUrl: record.sourceUrl,
        confidence: record.confidence,
        dataOrigin: 'automated',
        dedupeKey: record.dedupeKey,
        changePercent,
        isVerified: false,
        publishedAt: new Date().toISOString(),
      },
    } as any);
    return 'created';
  } catch (error) {
    const concurrent = await query.findOne({
      where: { dedupeKey: record.dedupeKey },
    } as any);
    if (concurrent) return 'duplicate';
    throw error;
  }
};
