import type { Core } from '@strapi/strapi';
import { MockAgriDataAdapter } from './mock-adapter';
import { ingestAgriData } from './runner';
import { createStrapiAgriPricePersister } from './strapi-persister';
import type { AgriIngestionSummary } from './types';

let activeMockRun: Promise<AgriIngestionSummary> | null = null;

export const runMockAgriDataIngestion = (
  strapi: Core.Strapi,
  now = new Date(),
): Promise<AgriIngestionSummary> => {
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

export { MockAgriDataAdapter, ingestAgriData };
export type {
  AgriDataSourceAdapter,
  AgriIngestionSummary,
  AgriPriceRecord,
  AgriPricePersister,
} from './types';
