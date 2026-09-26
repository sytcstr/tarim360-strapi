import type { Core } from '@strapi/strapi';
import { MockAgriDataAdapter } from './mock-adapter';
import { ingestAgriData } from './runner';
import { decideMockAgriIngestion } from './production-guard';
import { createStrapiAgriPricePersister } from './strapi-persister';
import type { AgriIngestionSummary } from './types';

let activeMockRun: Promise<AgriIngestionSummary> | null = null;

export const runMockAgriDataIngestion = (
  strapi: Core.Strapi,
  now = new Date(),
): Promise<AgriIngestionSummary> => {
  // Hard lock: the mock adapter fabricates prices and can never run against a
  // production (or unknown) environment, even if it is called directly.
  const decision = decideMockAgriIngestion();
  if (!decision.allowed) {
    const at = now.toISOString();
    return Promise.resolve({
      adapter: 'mock',
      received: 0,
      created: 0,
      duplicates: 0,
      invalid: 0,
      startedAt: at,
      finishedAt: at,
      skipped: true,
      skippedReason: decision.reason,
    });
  }
  if (activeMockRun) return activeMockRun;
  activeMockRun = ingestAgriData({
    adapter: new MockAgriDataAdapter(),
    persist: createStrapiAgriPricePersister(strapi),
    now,
  }).finally(() => {
    activeMockRun = null;
  });
  return activeMockRun;
};

export { MockAgriDataAdapter, ingestAgriData, decideMockAgriIngestion };
export type {
  AgriDataSourceAdapter,
  AgriIngestionSummary,
  AgriPriceRecord,
  AgriPricePersister,
} from './types';
