export type WeatherProvince = {
  id: number;
  documentId?: string;
  name: string;
  slug: string;
  latitude: number;
  longitude: number;
};

export type AgriWeatherRecord = {
  province: WeatherProvince;
  temperature: number;
  precipitation: number;
  windSpeed: number;
  humidity: number | null;
  forecastAt: string;
  fetchedAt: string;
  expiresAt: string;
  sourceName: string;
  sourceUrl: string;
};

export type PersistableAgriWeatherRecord = AgriWeatherRecord & {
  dedupeKey: string;
};

export type WeatherHttpResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export type WeatherHttpClient = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<WeatherHttpResponse>;

export interface AgriWeatherAdapter {
  readonly id: string;
  fetch(province: WeatherProvince, now: Date): Promise<AgriWeatherRecord>;
}

export type WeatherPersistResult = 'created' | 'duplicate';

export type AgriWeatherPersister = (
  record: PersistableAgriWeatherRecord,
) => Promise<WeatherPersistResult>;

export type AgriWeatherIngestionSummary = {
  adapter: string;
  provinces: number;
  created: number;
  duplicates: number;
  failed: number;
  startedAt: string;
  finishedAt: string;
};
