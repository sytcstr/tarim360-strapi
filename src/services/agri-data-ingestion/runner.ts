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
    const result = await persist({
      ...normalized,
      dedupeKey: buildAgriDedupeKey(normalized),
    });
    if (result === 'created') created += 1;
    else duplicates += 1;
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
