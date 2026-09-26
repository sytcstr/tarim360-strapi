/**
 * Static agricultural REFERENCE catalogues (no prices, no market data).
 *
 *  - 81 Turkish provinces (plate 01-81)
 *  - 52 agricultural products (name / category / default unit only)
 *
 * Prices are dynamic data and must come from a real provider; they never live
 * in these files. Validation is a pure function so tests (and the seed engine)
 * refuse a malformed catalogue before anything touches a database.
 */
import provincesJson from '../seeds/data/turkey-provinces.json';
import productsJson from '../seeds/data/agri-products.json';

export type ProvinceCatalogRow = {
  name: string;
  slug: string;
  plateCode: string;
  region: string;
  latitude: number;
  longitude: number;
  isActive: boolean;
};

export type ProductCatalogRow = {
  name: string;
  slug: string;
  code: string;
  category: string;
  defaultUnit: string;
  isActive: boolean;
};

export const EXPECTED_PROVINCE_COUNT = 81;
export const EXPECTED_PRODUCT_COUNT = 52;

export const PROVINCE_REGIONS = [
  'Marmara',
  'Ege',
  'Akdeniz',
  'İç Anadolu',
  'Karadeniz',
  'Doğu Anadolu',
  'Güneydoğu Anadolu',
] as const;

export const PRODUCT_CATEGORIES = [
  'Hububat',
  'Bakliyat',
  'Yağlı Tohumlar',
  'Sebze',
  'Meyve',
  'Endüstri Bitkileri',
  'Kuruyemiş',
  'Yem Bitkileri',
] as const;

export const PRODUCT_UNITS = ['kg', 'ton', 'adet', 'lt'] as const;

/** Keys that must never appear in a reference row (they are dynamic data). */
export const FORBIDDEN_PRICE_KEYS = [
  'price',
  'minPrice',
  'maxPrice',
  'averagePrice',
  'currency',
  'changePercent',
  'observedAt',
  'sourceName',
  'sourceUrl',
] as const;

export const provinceCatalog: ProvinceCatalogRow[] = provincesJson as ProvinceCatalogRow[];
export const productCatalog: ProductCatalogRow[] = productsJson as ProductCatalogRow[];

const duplicates = (values: string[]): string[] => {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) dup.add(v);
    seen.add(v);
  }
  return [...dup];
};

export const validateProvinceCatalog = (rows: ProvinceCatalogRow[]): string[] => {
  const errors: string[] = [];
  if (rows.length !== EXPECTED_PROVINCE_COUNT) {
    errors.push(`province: expected ${EXPECTED_PROVINCE_COUNT} rows, got ${rows.length}`);
  }
  for (const [field, label] of [
    ['name', 'name'],
    ['slug', 'slug'],
    ['plateCode', 'plateCode'],
  ] as const) {
    const dup = duplicates(rows.map((r) => String(r[field] ?? '')));
    if (dup.length) errors.push(`province: duplicate ${label}: ${dup.join(', ')}`);
  }
  rows.forEach((row, index) => {
    const label = `province ${row.name || `#${index + 1}`}`;
    if (!String(row.name ?? '').trim()) errors.push(`${label}: empty name`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(row.slug ?? ''))) errors.push(`${label}: invalid slug`);
    const expectedPlate = String(index + 1).padStart(2, '0');
    if (row.plateCode !== expectedPlate) {
      errors.push(`${label}: plateCode ${row.plateCode} is not ${expectedPlate}`);
    }
    if (!(PROVINCE_REGIONS as readonly string[]).includes(row.region)) {
      errors.push(`${label}: invalid region "${row.region}"`);
    }
    if (!Number.isFinite(row.latitude) || row.latitude < 35 || row.latitude > 43) {
      errors.push(`${label}: invalid latitude`);
    }
    if (!Number.isFinite(row.longitude) || row.longitude < 25 || row.longitude > 45) {
      errors.push(`${label}: invalid longitude`);
    }
    if (row.isActive !== true) errors.push(`${label}: not active`);
  });
  return errors;
};

export const validateProductCatalog = (rows: ProductCatalogRow[]): string[] => {
  const errors: string[] = [];
  if (rows.length !== EXPECTED_PRODUCT_COUNT) {
    errors.push(`product: expected ${EXPECTED_PRODUCT_COUNT} rows, got ${rows.length}`);
  }
  for (const field of ['name', 'slug', 'code'] as const) {
    const dup = duplicates(rows.map((r) => String(r[field] ?? '')));
    if (dup.length) errors.push(`product: duplicate ${field}: ${dup.join(', ')}`);
  }
  for (const row of rows) {
    const label = `product ${row.name || row.slug}`;
    if (!String(row.name ?? '').trim()) errors.push(`${label}: empty name`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(row.slug ?? ''))) errors.push(`${label}: invalid slug`);
    if (!/^[A-Z0-9_]+$/.test(String(row.code ?? ''))) errors.push(`${label}: invalid code`);
    if (!(PRODUCT_CATEGORIES as readonly string[]).includes(row.category)) {
      errors.push(`${label}: invalid category "${row.category}"`);
    }
    if (!(PRODUCT_UNITS as readonly string[]).includes(row.defaultUnit)) {
      errors.push(`${label}: invalid defaultUnit "${row.defaultUnit}"`);
    }
    if (row.isActive !== true) errors.push(`${label}: not active`);
    for (const key of FORBIDDEN_PRICE_KEYS) {
      if (Object.prototype.hasOwnProperty.call(row, key)) {
        errors.push(`${label}: reference row must not carry "${key}" (dynamic data)`);
      }
    }
  }
  return errors;
};
