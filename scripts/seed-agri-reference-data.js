'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { compileStrapi, createStrapi } = require('@strapi/strapi');

const provinces = require('../src/seeds/data/turkey-provinces.json');
const products = require('../src/seeds/data/agri-products.json');

const PROVINCE_UID = 'api::province.province';
const PRODUCT_UID = 'api::agri-product.agri-product';
const ALLOWED_CATEGORIES = new Set([
  'Hububat',
  'Bakliyat',
  'Yağlı Tohumlar',
  'Sebze',
  'Meyve',
  'Endüstri Bitkileri',
  'Kuruyemiş',
  'Yem Bitkileri',
]);

const loadLocalEnv = () => {
  const envPath = path.resolve(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!key || process.env[key] !== undefined) continue;
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
};

const assertLocalSqlite = () => {
  loadLocalEnv();
  const nodeEnv = String(process.env.NODE_ENV ?? 'development').toLowerCase();
  const databaseClient = String(
    process.env.DATABASE_CLIENT ?? 'sqlite',
  ).toLowerCase();
  const databaseUrl = String(process.env.DATABASE_URL ?? '').trim();
  const databaseHost = String(process.env.DATABASE_HOST ?? '').trim().toLowerCase();
  const cloudSignal = Object.entries(process.env).some(
    ([key, value]) =>
      key.startsWith('STRAPI_CLOUD') && String(value ?? '').trim().length > 0,
  );

  if (nodeEnv === 'production') {
    throw new Error('Seed refused: NODE_ENV=production is not allowed.');
  }
  if (databaseClient !== 'sqlite') {
    throw new Error(
      `Seed refused: DATABASE_CLIENT must be sqlite, received ${databaseClient}.`,
    );
  }
  if (databaseUrl) {
    throw new Error('Seed refused: DATABASE_URL is configured.');
  }
  if (databaseHost && !['localhost', '127.0.0.1', '::1'].includes(databaseHost)) {
    throw new Error('Seed refused: a non-local DATABASE_HOST is configured.');
  }
  if (cloudSignal) {
    throw new Error('Seed refused: Strapi Cloud environment variables detected.');
  }

  const filename = String(
    process.env.DATABASE_FILENAME ?? '.tmp/data.db',
  ).trim();
  const projectRoot = path.resolve(process.cwd());
  const databaseFile = path.resolve(projectRoot, filename);
  if (
    !filename ||
    !databaseFile.startsWith(`${projectRoot}${path.sep}`) ||
    path.extname(databaseFile).toLowerCase() !== '.db'
  ) {
    throw new Error('Seed refused: SQLite file must be a .db inside the project.');
  }

  process.env.NODE_ENV = 'development';
  process.env.DATABASE_CLIENT = 'sqlite';
  process.env.DATABASE_FILENAME = filename;
  return databaseFile;
};

const assertUnique = (rows, field, label) => {
  const seen = new Set();
  for (const row of rows) {
    const value = String(row[field] ?? '').trim();
    if (!value) throw new Error(`${label}: ${field} is empty.`);
    if (seen.has(value)) {
      throw new Error(`${label}: duplicate ${field} "${value}".`);
    }
    seen.add(value);
  }
};

const validateCatalogs = () => {
  if (provinces.length !== 81) {
    throw new Error(`Province catalog must contain 81 rows, got ${provinces.length}.`);
  }
  assertUnique(provinces, 'name', 'Province catalog');
  assertUnique(provinces, 'slug', 'Province catalog');
  assertUnique(provinces, 'plateCode', 'Province catalog');
  provinces.forEach((province, index) => {
    const expectedPlate = String(index + 1).padStart(2, '0');
    if (province.plateCode !== expectedPlate) {
      throw new Error(
        `Province catalog: expected plate ${expectedPlate}, got ${province.plateCode}.`,
      );
    }
    if (
      province.isActive !== true ||
      !province.region ||
      !Number.isFinite(province.latitude) ||
      !Number.isFinite(province.longitude) ||
      province.latitude < 35 ||
      province.latitude > 43 ||
      province.longitude < 25 ||
      province.longitude > 45
    ) {
      throw new Error(`Province catalog: invalid row for ${province.name}.`);
    }
  });

  if (products.length < 40) {
    throw new Error(`Product catalog must contain at least 40 rows, got ${products.length}.`);
  }
  assertUnique(products, 'name', 'Product catalog');
  assertUnique(products, 'slug', 'Product catalog');
  assertUnique(products, 'code', 'Product catalog');
  products.forEach((product) => {
    if (
      product.isActive !== true ||
      !product.defaultUnit ||
      !ALLOWED_CATEGORIES.has(product.category)
    ) {
      throw new Error(`Product catalog: invalid row for ${product.name}.`);
    }
  });
};

const findIdentityConflict = (bySlug, bySecondary, label) => {
  if (bySlug && bySecondary && Number(bySlug.id) !== Number(bySecondary.id)) {
    throw new Error(`${label}: slug and secondary key point to different records.`);
  }
  return bySlug || bySecondary || null;
};

const publishDraftDocument = async (strapi, uid, document) => {
  if (!document?.documentId || document.publishedAt) return;
  await strapi.documents(uid).publish({
    documentId: document.documentId,
    populate: {},
  });
};

const seedProvinces = async (strapi, now) => {
  const query = strapi.db.query(PROVINCE_UID);
  let created = 0;
  let updated = 0;
  for (const province of provinces) {
    const bySlug = await query.findOne({ where: { slug: province.slug } });
    const byPlate = await query.findOne({
      where: { plateCode: province.plateCode },
    });
    const existing = findIdentityConflict(
      bySlug,
      byPlate,
      `Province ${province.name}`,
    );
    const data = {
      name: province.name,
      slug: province.slug,
      plateCode: province.plateCode,
      regionName: province.region,
      latitude: province.latitude,
      longitude: province.longitude,
      isActive: true,
    };
    if (existing) {
      const updatedRow = await query.update({ where: { id: existing.id }, data });
      await publishDraftDocument(strapi, PROVINCE_UID, updatedRow);
      updated += 1;
    } else {
      const createdRow = await query.create({ data });
      await publishDraftDocument(strapi, PROVINCE_UID, createdRow);
      created += 1;
    }
  }
  return { created, updated };
};

const seedProducts = async (strapi, now) => {
  const query = strapi.db.query(PRODUCT_UID);
  let created = 0;
  let updated = 0;
  for (const product of products) {
    const bySlug = await query.findOne({ where: { slug: product.slug } });
    const byCode = await query.findOne({ where: { code: product.code } });
    const existing = findIdentityConflict(
      bySlug,
      byCode,
      `Product ${product.name}`,
    );
    const data = {
      name: product.name,
      slug: product.slug,
      code: product.code,
      categoryName: product.category,
      defaultUnit: product.defaultUnit,
      isActive: true,
    };
    if (existing) {
      const updatedRow = await query.update({ where: { id: existing.id }, data });
      await publishDraftDocument(strapi, PRODUCT_UID, updatedRow);
      updated += 1;
    } else {
      const createdRow = await query.create({ data });
      await publishDraftDocument(strapi, PRODUCT_UID, createdRow);
      created += 1;
    }
  }
  return { created, updated };
};

const verifySeed = async (strapi) => {
  const provinceRows = await strapi.db.query(PROVINCE_UID).findMany({
    where: { slug: { $in: provinces.map((item) => item.slug) } },
  });
  const productRows = await strapi.db.query(PRODUCT_UID).findMany({
    where: { slug: { $in: products.map((item) => item.slug) } },
  });
  const weatherReady = provinceRows.filter(
    (province) =>
      province.isActive === true &&
      Number.isFinite(Number(province.latitude)) &&
      Number.isFinite(Number(province.longitude)),
  ).length;

  if (provinceRows.length !== provinces.length) {
    throw new Error(
      `Seed verification failed: expected ${provinces.length} provinces, got ${provinceRows.length}.`,
    );
  }
  if (productRows.length !== products.length) {
    throw new Error(
      `Seed verification failed: expected ${products.length} products, got ${productRows.length}.`,
    );
  }
  if (weatherReady !== 81) {
    throw new Error(
      `Weather verification failed: expected 81 coordinate-ready provinces, got ${weatherReady}.`,
    );
  }
  return {
    provinces: provinceRows.length,
    products: productRows.length,
    weatherReady,
  };
};

const seedReferenceData = async (strapi) => {
  validateCatalogs();
  const now = new Date().toISOString();
  const provinceResult = await seedProvinces(strapi, now);
  const productResult = await seedProducts(strapi, now);
  const verification = await verifySeed(strapi);
  return {
    provinces: provinceResult,
    products: productResult,
    verification,
  };
};

const main = async () => {
  const databaseFile = assertLocalSqlite();
  console.log(`Local SQLite seed target: ${databaseFile}`);

  const appContext = await compileStrapi();
  const strapi = await createStrapi(appContext).load();
  try {
    console.log(JSON.stringify(await seedReferenceData(strapi), null, 2));
  } finally {
    await strapi.destroy();
  }
};

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

module.exports = {
  seedReferenceData,
  validateCatalogs,
};
