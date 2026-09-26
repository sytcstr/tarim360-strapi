/**
 * Reference seed engine: 81 provinces + 52 agricultural products.
 *
 * SAFETY CONTRACT
 *  - REFERENCE_SEED_MODE = off | dry-run | apply, default off. `off` runs no
 *    query and no mutation.
 *  - dry-run is read-only.
 *  - apply is CREATE-ONLY: it creates + publishes catalogue rows that are
 *    missing and never updates or deletes anything. Existing rows (whatever an
 *    admin changed) are left untouched.
 *  - Identity: province = slug + plateCode, product = slug + code. If a
 *    catalogue row collides with an existing row inconsistently (same slug but
 *    another plate/code, or slug/plate pointing at different documents) the
 *    whole run FAILS CLOSED: nothing is written.
 *  - Scope is exactly the two reference collections. No user data, hub-content,
 *    listings, purchases, messages... are ever read or written.
 *  - Version marker (`agri-reference@N`) is stored only after a fully
 *    successful apply, and it never short-circuits the integrity check: every
 *    dry-run/apply re-checks that all catalogue rows really exist, so a marker
 *    can never hide a missing record.
 *  - Logs are aggregate counts and catalogue keys (slug/plate/code) only.
 */
import type { Core } from '@strapi/strapi';
import {
  EXPECTED_PRODUCT_COUNT,
  EXPECTED_PROVINCE_COUNT,
  productCatalog,
  provinceCatalog,
  validateProductCatalog,
  validateProvinceCatalog,
  type ProductCatalogRow,
  type ProvinceCatalogRow,
} from './reference-catalogs';

export const REFERENCE_SEED_VERSION = 'agri-reference@1';
export const PROVINCE_UID = 'api::province.province';
export const PRODUCT_UID = 'api::agri-product.agri-product';

const STORE_KEY = 'reference_seed_version';

export type ReferenceSeedMode = 'off' | 'dry-run' | 'apply';

export const readReferenceSeedMode = (
  env: Record<string, string | undefined> = process.env,
): ReferenceSeedMode => {
  const raw = String(env.REFERENCE_SEED_MODE ?? '').trim().toLowerCase();
  return raw === 'dry-run' || raw === 'apply' ? raw : 'off';
};

export type CollectionReport = {
  expected: number;
  existing: number;
  existingUnpublished: number;
  wouldCreate: number;
  created: number;
  conflicts: number;
};

export type ReferenceSeedStatus =
  | 'off'
  | 'dry-run'
  | 'applied'
  | 'up-to-date'
  | 'conflict'
  | 'invalid-catalog'
  | 'failed';

export type ReferenceSeedReport = {
  mode: ReferenceSeedMode;
  version: string;
  status: ReferenceSeedStatus;
  storedVersion: string | null;
  versionWritten: boolean;
  province: CollectionReport;
  product: CollectionReport;
  conflictKeys: string[];
  errors: string[];
};

const emptyCollection = (expected: number): CollectionReport => ({
  expected,
  existing: 0,
  existingUnpublished: 0,
  wouldCreate: 0,
  created: 0,
  conflicts: 0,
});

type Row = Record<string, any>;

type Plan<T> = {
  toCreate: T[];
  report: CollectionReport;
  conflictKeys: string[];
};

const plan = async <T extends { slug: string }>(
  strapi: Core.Strapi,
  uid: string,
  entries: T[],
  secondaryField: 'plateCode' | 'code',
  secondaryOf: (entry: T) => string,
  label: string,
): Promise<Plan<T>> => {
  const slugs = entries.map((e) => e.slug);
  const secondaries = entries.map(secondaryOf);
  const rows: Row[] = await strapi.db.query(uid).findMany({
    where: { $or: [{ slug: { $in: slugs } }, { [secondaryField]: { $in: secondaries } }] },
    limit: 1000,
  });

  const report = emptyCollection(entries.length);
  const conflictKeys: string[] = [];
  const toCreate: T[] = [];

  for (const entry of entries) {
    const secondary = secondaryOf(entry);
    const related = rows.filter((r) => r.slug === entry.slug || r[secondaryField] === secondary);
    if (related.length === 0) {
      toCreate.push(entry);
      report.wouldCreate += 1;
      continue;
    }
    const documents = new Set(related.map((r) => String(r.documentId ?? r.id)));
    const consistent = related.filter((r) => r.slug === entry.slug && r[secondaryField] === secondary);
    if (documents.size !== 1 || consistent.length !== related.length) {
      report.conflicts += 1;
      conflictKeys.push(`${label}:${entry.slug}/${secondary}`);
      continue;
    }
    report.existing += 1;
    if (!related.some((r) => r.publishedAt)) report.existingUnpublished += 1;
  }
  return { toCreate, report, conflictKeys };
};

const provinceData = (p: ProvinceCatalogRow) => ({
  name: p.name,
  slug: p.slug,
  plateCode: p.plateCode,
  regionName: p.region,
  latitude: p.latitude,
  longitude: p.longitude,
  isActive: true,
});

const productData = (p: ProductCatalogRow) => ({
  name: p.name,
  slug: p.slug,
  code: p.code,
  categoryName: p.category,
  defaultUnit: p.defaultUnit,
  isActive: true,
});

export type ReferenceSeedOptions = {
  mode: ReferenceSeedMode;
  provinces?: ProvinceCatalogRow[];
  products?: ProductCatalogRow[];
  /** Test hook: throw after N successful creates (partial-failure simulation). */
  failAfterCreates?: number;
};

export const runReferenceSeed = async (
  strapi: Core.Strapi,
  options: ReferenceSeedOptions,
): Promise<ReferenceSeedReport> => {
  const provinces = options.provinces ?? provinceCatalog;
  const products = options.products ?? productCatalog;
  const report: ReferenceSeedReport = {
    mode: options.mode,
    version: REFERENCE_SEED_VERSION,
    status: 'off',
    storedVersion: null,
    versionWritten: false,
    province: emptyCollection(provinces.length),
    product: emptyCollection(products.length),
    conflictKeys: [],
    errors: [],
  };
  if (options.mode === 'off') return report;

  const catalogErrors = [
    ...(options.provinces ? [] : validateProvinceCatalog(provinces)),
    ...(options.products ? [] : validateProductCatalog(products)),
  ];
  if (catalogErrors.length) {
    report.status = 'invalid-catalog';
    report.errors = catalogErrors;
    return report;
  }

  const store = strapi.store({ type: 'core', name: 'reference_seed' });
  const stored = (await store.get({ key: STORE_KEY })) as { version?: string } | null;
  report.storedVersion = stored?.version ?? null;

  try {
    const provincePlan = await plan(strapi, PROVINCE_UID, provinces, 'plateCode', (p) => p.plateCode, 'province');
    const productPlan = await plan(strapi, PRODUCT_UID, products, 'code', (p) => p.code, 'product');
    report.province = provincePlan.report;
    report.product = productPlan.report;
    report.conflictKeys = [...provincePlan.conflictKeys, ...productPlan.conflictKeys];

    if (report.conflictKeys.length) {
      report.status = 'conflict';
      return report; // fail closed: nothing written
    }
    if (options.mode === 'dry-run') {
      report.status = 'dry-run';
      return report;
    }

    // apply: create-only, creation happens strictly after the full plan is clean.
    let createdSoFar = 0;
    const guard = () => {
      if (options.failAfterCreates != null && createdSoFar >= options.failAfterCreates) {
        throw new Error('simulated partial failure');
      }
    };
    for (const p of provincePlan.toCreate) {
      guard();
      await strapi.documents(PROVINCE_UID as any).create({ data: provinceData(p), status: 'published' } as any);
      createdSoFar += 1;
      report.province.created += 1;
    }
    for (const p of productPlan.toCreate) {
      guard();
      await strapi.documents(PRODUCT_UID as any).create({ data: productData(p), status: 'published' } as any);
      createdSoFar += 1;
      report.product.created += 1;
    }

    // Post-apply integrity check: every catalogue row must exist and be published.
    const verify = async (uid: string, field: 'slug', values: string[]) =>
      strapi.db.query(uid).count({ where: { [field]: { $in: values }, publishedAt: { $notNull: true } } });
    const provincePublished = await verify(PROVINCE_UID, 'slug', provinces.map((p) => p.slug));
    const productPublished = await verify(PRODUCT_UID, 'slug', products.map((p) => p.slug));
    if (provincePublished < provinces.length || productPublished < products.length) {
      // e.g. a pre-existing unpublished row: not ours to publish (no updates).
      report.status = 'failed';
      report.errors.push(
        `post-apply check: published province ${provincePublished}/${provinces.length}, product ${productPublished}/${products.length}`,
      );
      return report;
    }

    await store.set({
      key: STORE_KEY,
      value: { version: REFERENCE_SEED_VERSION, appliedAt: new Date().toISOString() },
    });
    report.versionWritten = true;
    report.storedVersion = REFERENCE_SEED_VERSION;
    report.status = createdSoFar === 0 ? 'up-to-date' : 'applied';
    return report;
  } catch (error) {
    report.status = 'failed';
    report.errors.push(String((error as Error)?.message ?? error));
    return report; // no version written
  }
};

export const formatReferenceSeedReport = (r: ReferenceSeedReport): string => {
  const col = (name: string, c: CollectionReport) =>
    `${name}: expected=${c.expected} existing=${c.existing} existingUnpublished=${c.existingUnpublished} wouldCreate=${c.wouldCreate} created=${c.created} conflicts=${c.conflicts}`;
  return [
    `[reference-seed] mode=${r.mode} version=${r.version} status=${r.status} storedVersion=${r.storedVersion ?? 'none'} versionWritten=${r.versionWritten}`,
    `[reference-seed] ${col('province', r.province)}`,
    `[reference-seed] ${col('product', r.product)}`,
    ...(r.conflictKeys.length ? [`[reference-seed] conflicts: ${r.conflictKeys.join(', ')}`] : []),
    ...(r.errors.length ? [`[reference-seed] errors: ${r.errors.join(' | ')}`] : []),
  ].join('\n');
};

/** Bootstrap entry: `off` (default) does nothing at all; never throws. */
export const runReferenceSeedIfEnabled = async (strapi: Core.Strapi): Promise<void> => {
  const mode = readReferenceSeedMode();
  if (mode === 'off') return;
  try {
    const report = await runReferenceSeed(strapi, { mode });
    const text = formatReferenceSeedReport(report);
    if (report.status === 'conflict' || report.status === 'failed' || report.status === 'invalid-catalog') {
      strapi.log.error(text);
    } else {
      strapi.log.info(text);
    }
  } catch (error) {
    strapi.log.error(`[reference-seed] unexpected failure: ${String((error as Error)?.message ?? error)}`);
  }
};

export { EXPECTED_PRODUCT_COUNT, EXPECTED_PROVINCE_COUNT };
