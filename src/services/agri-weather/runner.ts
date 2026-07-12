import { buildWeatherDedupeKey } from './normalization';
import type {
  AgriWeatherAdapter,
  AgriWeatherIngestionSummary,
  AgriWeatherPersister,
  WeatherProvince,
} from './types';

export const ingestAgriWeather = async ({
  adapter,
  provinces,
  persist,
  now = new Date(),
}: {
  adapter: AgriWeatherAdapter;
  provinces: WeatherProvince[];
  persist: AgriWeatherPersister;
  now?: Date;
}): Promise<AgriWeatherIngestionSummary> => {
  const startedAt = new Date().toISOString();
  let created = 0;
  let duplicates = 0;
  let failed = 0;

  for (const province of provinces) {
    try {
      const record = await adapter.fetch(province, now);
      const result = await persist({
        ...record,
        dedupeKey: buildWeatherDedupeKey(record),
      });
      if (result === 'created') created += 1;
      else duplicates += 1;
    } catch (_) {
      failed += 1;
    }
  }

  return {
    adapter: adapter.id,
    provinces: provinces.length,
    created,
    duplicates,
    failed,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
};
