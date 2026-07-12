import {
  buildAgriDedupeKey,
  normalizeAgriPriceRecord,
} from './normalization';
import type {
  AgriDataSourceAdapter,
  AgriIngestionSummary,
  AgriPriceRecord,
  AgriPricePersister,
} from './types';

export const ingestAgriData = async ({
  adapter,
  persist,
  now = new Date(),
}: {
  adapter: AgriDataSourceAdapter;
  persist: AgriPricePersister;
  now?: Date;
}): Promise<AgriIngestionSummary> => {
  const startedAt = new Date().toISOString();
  const rows = await adapter.fetch({ now });
  let created = 0;
  let duplicates = 0;
  let invalid = 0;

  for (const row of rows) {
    let normalized: AgriPriceRecord;
    try {
      normalized = normalizeAgriPriceRecord(row);
    } catch (_) {
      invalid += 1;
      continue;
    }
    try {
      const result = await persist({
        ...normalized,
        dedupeKey: buildAgriDedupeKey(normalized),
      });
      if (result === 'created') created += 1;
      else duplicates += 1;
    } catch (error) {
      invalid += 1;
      const logger = (globalThis as { strapi?: { log?: { warn?: (message: string) => void } } })
        .strapi?.log;
      logger?.warn?.(
        `[agri-ingestion] Skipped ${normalized.productName} from ${normalized.sourceName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  return {
    adapter: adapter.id,
    received: rows.length,
    created,
    duplicates,
    invalid,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
};
