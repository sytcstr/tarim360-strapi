/**
 * TobbAgriculturalPriceProvider: fetch -> parse -> normalise -> map -> validate.
 * It only READS from TOBB and returns validated observations plus an aggregate
 * report; persistence is a separate layer. There is no fallback data of any
 * kind: a page that fails contributes nothing.
 */
import type { ProductProbe, RealPriceObservation, RejectReason } from '../types';
import { TOBB_BASE_URL, productPageUrl, type TobbFetcher } from './fetcher';
import { autoIngestProducts, productMap, type ProductMapEntry, type TobbCandidate } from './maps';
import { normalizeTobbRow } from './normalize';
import { parseTobbProductPage } from './parser';

export type ProviderReport = {
  provider: 'tobb';
  productsInScope: number;
  pagesFetched: number;
  pagesNoData: number;
  pagesFailed: number;
  rowsParsed: number;
  validObservations: number;
  rejected: Partial<Record<RejectReason, number>>;
  stale: number; // valid rows that are not "fresh"
  ambiguousProducts: number;
  noMatchProducts: number;
  probes: ProductProbe[];
};

export type CollectOptions = {
  fetcher: TobbFetcher;
  now?: Date;
  maxAgeDays?: number;
  /** Dry-run only: also fetch candidate pages of AMBIGUOUS products, for the report. Never ingested. */
  probeAmbiguous?: boolean;
};

const addReject = (target: Partial<Record<RejectReason, number>>, reason: RejectReason) => {
  target[reason] = (target[reason] ?? 0) + 1;
};

export const collectTobbObservations = async (
  options: CollectOptions,
): Promise<{ observations: RealPriceObservation[]; report: ProviderReport }> => {
  const now = options.now ?? new Date();
  const scope = autoIngestProducts();
  const report: ProviderReport = {
    provider: 'tobb',
    productsInScope: scope.length,
    pagesFetched: 0,
    pagesNoData: 0,
    pagesFailed: 0,
    rowsParsed: 0,
    validObservations: 0,
    rejected: {},
    stale: 0,
    ambiguousProducts: productMap.filter((p) => p.confidence === 'AMBIGUOUS').length,
    noMatchProducts: productMap.filter((p) => p.confidence === 'NO_MATCH').length,
    probes: [],
  };
  const observations: RealPriceObservation[] = [];

  const visit = async (product: ProductMapEntry, candidate: TobbCandidate, ingest: boolean): Promise<void> => {
    const probe: ProductProbe = {
      code: product.code,
      class: product.class,
      confidence: product.confidence,
      tobbProduct: candidate.name,
      pageStatus: 'not-fetched',
      rowsParsed: 0,
      valid: 0,
      rejected: {},
      latestObservedAt: null,
    };
    report.probes.push(probe);
    const path = productPageUrl(candidate.ana, candidate.alt);
    const res = await options.fetcher.get(path);
    if ('reason' in res) {
      probe.pageStatus = 'error';
      probe.pageError = res.reason + (res.status ? ` ${res.status}` : '');
      report.pagesFailed += 1;
      return;
    }
    report.pagesFetched += 1;
    const page = parseTobbProductPage(res.body);
    if (page.status === 'error') {
      probe.pageStatus = 'error';
      probe.pageError = page.reason.slice(0, 160);
      report.pagesFailed += 1;
      return;
    }
    if (page.status === 'no-data') {
      probe.pageStatus = 'no-data';
      report.pagesNoData += 1;
      return;
    }
    probe.pageStatus = 'ok';
    probe.rowsParsed = page.rows.length;
    report.rowsParsed += page.rows.length;
    for (const row of page.rows) {
      const result = normalizeTobbRow(row, {
        product,
        tobbUnit: page.unit,
        ana: candidate.ana,
        alt: candidate.alt,
        tobbProductName: page.product,
        sourceUrl: `${TOBB_BASE_URL}/${path}`,
        now,
        maxAgeDays: options.maxAgeDays,
      });
      if ('reason' in result) {
        addReject(probe.rejected, result.reason);
        addReject(report.rejected, result.reason);
        continue;
      }
      probe.valid += 1;
      if (!probe.latestObservedAt || result.observation.observedAt > probe.latestObservedAt) {
        probe.latestObservedAt = result.observation.observedAt;
      }
      if (ingest) {
        observations.push(result.observation);
        report.validObservations += 1;
        if (result.observation.freshness !== 'fresh') report.stale += 1;
      }
    }
  };

  for (const product of scope) {
    if (product.tobb) await visit(product, product.tobb, true);
  }
  if (options.probeAmbiguous) {
    for (const product of productMap.filter((p) => p.confidence === 'AMBIGUOUS')) {
      for (const candidate of product.candidates) await visit(product, candidate, false);
    }
  }
  return { observations, report };
};
