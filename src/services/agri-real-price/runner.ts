/**
 * Real agricultural price ingestion (TOBB) with a safe mode gate:
 *
 *   AGRI_REAL_PRICE_INGESTION_MODE = off | dry-run | apply   (default off)
 *
 *  - off      : no network, no database access.
 *  - dry-run  : fetches/parses TOBB and READS the database (existence checks);
 *               never writes.
 *  - apply    : creates only validated observations that are not already
 *               stored (dedupeKey) and whose product/province reference rows
 *               already exist. Never updates or deletes anything; never
 *               creates reference rows; a provider failure leaves existing
 *               observations untouched and writes no fallback.
 */
import type { Core } from '@strapi/strapi';
import type { RealPriceMode, RealPriceObservation } from './types';
import { collectTobbObservations, type ProviderReport } from './tobb/provider';
import { createTobbFetcher, type TobbFetcher } from './tobb/fetcher';

export const OBSERVATION_UID = 'api::agri-price-observation.agri-price-observation';
const PRODUCT_UID = 'api::agri-product.agri-product';
const PROVINCE_UID = 'api::province.province';

export type RealPriceRunReport = {
  mode: RealPriceMode;
  status: 'off' | 'dry-run' | 'applied' | 'provider-failed' | 'failed';
  provider: ProviderReport | null;
  wouldCreate: number;
  created: number;
  duplicates: number;
  referenceMissing: number;
  errors: string[];
};

export type RunOptions = {
  mode: RealPriceMode;
  fetcher?: TobbFetcher;
  now?: Date;
  maxAgeDays?: number;
  probeAmbiguous?: boolean;
};

let activeRun: Promise<RealPriceRunReport> | null = null;

const emptyReport = (mode: RealPriceMode): RealPriceRunReport => ({
  mode,
  status: mode === 'off' ? 'off' : 'dry-run',
  provider: null,
  wouldCreate: 0,
  created: 0,
  duplicates: 0,
  referenceMissing: 0,
  errors: [],
});

const run = async (strapi: Core.Strapi, options: RunOptions): Promise<RealPriceRunReport> => {
  const report = emptyReport(options.mode);
  if (options.mode === 'off') return report; // no network, no database

  const fetcher = options.fetcher ?? createTobbFetcher();
  let collected;
  try {
    collected = await collectTobbObservations({
      fetcher,
      now: options.now,
      maxAgeDays: options.maxAgeDays,
      probeAmbiguous: options.probeAmbiguous && options.mode === 'dry-run',
    });
  } catch (error) {
    report.status = 'failed';
    report.errors.push(`provider: ${String((error as Error)?.message ?? error)}`);
    return report;
  }
  report.provider = collected.report;
  const { observations } = collected;
  const attempted = collected.report.pagesFetched + collected.report.pagesFailed;
  if (attempted > 0 && collected.report.pagesFetched === 0) {
    report.status = 'provider-failed'; // nothing reachable: write nothing, invent nothing
    return report;
  }
  if (observations.length === 0) {
    report.status = options.mode === 'apply' ? 'applied' : 'dry-run';
    return report;
  }

  try {
    const products = await strapi.db.query(PRODUCT_UID).findMany({
      where: { slug: { $in: [...new Set(observations.map((o) => o.productSlug))] } },
      limit: 500,
    });
    const provinces = await strapi.db.query(PROVINCE_UID).findMany({ where: {}, limit: 200 });
    const productBySlug = new Map<string, any>();
    for (const p of products) if (!productBySlug.has(p.slug) || p.publishedAt) productBySlug.set(p.slug, p);
    const provinceBySlug = new Map<string, any>();
    for (const p of provinces) if (!provinceBySlug.has(p.slug) || p.publishedAt) provinceBySlug.set(p.slug, p);

    const keys = observations.map((o) => o.dedupeKey);
    const existing = await strapi.db.query(OBSERVATION_UID).findMany({
      where: { dedupeKey: { $in: keys } },
      limit: keys.length + 10,
    });
    const known = new Set(existing.map((r: any) => r.dedupeKey));

    for (const obs of observations) {
      if (known.has(obs.dedupeKey)) {
        report.duplicates += 1;
        continue;
      }
      const product = productBySlug.get(obs.productSlug);
      if (!product || product.isActive === false) {
        report.referenceMissing += 1;
        continue;
      }
      const province = obs.provinceSlug ? provinceBySlug.get(obs.provinceSlug) : null;
      if (obs.provinceSlug && !province) {
        report.referenceMissing += 1;
        continue;
      }
      report.wouldCreate += 1;
      if (options.mode !== 'apply') continue;
      try {
        await createObservation(strapi, obs, product, province);
        report.created += 1;
        known.add(obs.dedupeKey);
      } catch (error) {
        // a concurrent run may have inserted it (dedupeKey is UNIQUE)
        const dup = await strapi.db.query(OBSERVATION_UID).findOne({ where: { dedupeKey: obs.dedupeKey } });
        if (dup) report.duplicates += 1;
        else report.errors.push(`create ${obs.dedupeKey}: ${String((error as Error)?.message ?? error)}`.slice(0, 200));
      }
    }
    report.status = options.mode === 'apply' ? 'applied' : 'dry-run';
  } catch (error) {
    report.status = 'failed';
    report.errors.push(`database: ${String((error as Error)?.message ?? error)}`);
  }
  return report;
};

const previousPrice = async (strapi: Core.Strapi, obs: RealPriceObservation, product: any, province: any) => {
  const previous = await strapi.db.query(OBSERVATION_UID).findOne({
    where: {
      product: { id: product.id },
      marketName: obs.marketName,
      unit: obs.unit,
      observedAt: { $lt: obs.observedAt },
      ...(province ? { province: { id: province.id } } : {}),
    },
    orderBy: { observedAt: 'desc' },
  });
  const value = Number(previous?.averagePrice ?? previous?.price);
  return Number.isFinite(value) && value > 0 ? value : null;
};

const createObservation = async (strapi: Core.Strapi, obs: RealPriceObservation, product: any, province: any) => {
  if (obs.provider !== 'tobb') throw new Error('only TOBB observations may be written by this provider');
  const prev = await previousPrice(strapi, obs, product, province);
  await strapi.documents(OBSERVATION_UID as any).create({
    data: {
      product: { connect: [product.documentId] },
      ...(province ? { province: { connect: [province.documentId] } } : {}),
      observedAt: obs.observedAt,
      fetchedAt: obs.fetchedAt,
      price: obs.price,
      minPrice: obs.minPrice,
      maxPrice: obs.maxPrice,
      averagePrice: obs.averagePrice,
      currency: obs.currency,
      unit: obs.unit,
      quantity: obs.quantity,
      transactionCount: obs.transactionCount,
      marketName: obs.marketName,
      sourceName: obs.sourceName,
      sourceUrl: obs.sourceUrl,
      provider: obs.provider,
      dataOrigin: 'automated',
      dedupeKey: obs.dedupeKey,
      changePercent: prev ? ((obs.averagePrice - prev) / prev) * 100 : null,
      notes: obs.notes,
      isVerified: false, // exchange-reported and attributed; not independently verified by us
    },
    status: 'published',
  } as any);
};

/** Serialised: a second call while a run is active shares that run. */
export const runRealPriceIngestion = (strapi: Core.Strapi, options: RunOptions): Promise<RealPriceRunReport> => {
  if (options.mode === 'off') return Promise.resolve(emptyReport('off'));
  if (activeRun) return activeRun;
  activeRun = run(strapi, options).finally(() => {
    activeRun = null;
  });
  return activeRun;
};

export const formatRealPriceReport = (r: RealPriceRunReport): string => {
  const p = r.provider;
  return [
    `[agri-real-price] mode=${r.mode} status=${r.status} wouldCreate=${r.wouldCreate} created=${r.created} duplicates=${r.duplicates} referenceMissing=${r.referenceMissing}`,
    ...(p
      ? [
          `[agri-real-price] provider=tobb productsInScope=${p.productsInScope} pagesFetched=${p.pagesFetched} pagesNoData=${p.pagesNoData} pagesFailed=${p.pagesFailed} rowsParsed=${p.rowsParsed} valid=${p.validObservations} stale=${p.stale} rejected=${JSON.stringify(p.rejected)} ambiguousProducts=${p.ambiguousProducts} noMatchProducts=${p.noMatchProducts}`,
        ]
      : []),
    ...(r.errors.length ? [`[agri-real-price] errors: ${r.errors.join(' | ')}`] : []),
  ].join('\n');
};
