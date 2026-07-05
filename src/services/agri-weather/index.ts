import type { Core } from '@strapi/strapi';
import { OpenMeteoAdapter } from './open-meteo-adapter';
import { ingestAgriWeather } from './runner';
import {
  createStrapiWeatherPersister,
  loadWeatherProvinces,
} from './strapi-persister';
import type {
  AgriWeatherIngestionSummary,
  WeatherHttpClient,
} from './types';

let activeRun: Promise<AgriWeatherIngestionSummary> | null = null;

export const runOpenMeteoWeatherIngestion = (
  strapi: Core.Strapi,
  options: {
    baseUrl: string;
    apiKey?: string;
    httpClient?: WeatherHttpClient;
    now?: Date;
  },
): Promise<AgriWeatherIngestionSummary> => {
  if (activeRun) return activeRun;
  activeRun = (async () => {
    const provinces = await loadWeatherProvinces(strapi);
    return ingestAgriWeather({
      adapter: new OpenMeteoAdapter({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        httpClient: options.httpClient,
      }),
      provinces,
      persist: createStrapiWeatherPersister(strapi),
      now: options.now,
    });
  })().finally(() => {
    activeRun = null;
  });
  return activeRun;
};

export { ingestAgriWeather, OpenMeteoAdapter };
export type {
  AgriWeatherIngestionSummary,
  AgriWeatherPersister,
  WeatherHttpClient,
  WeatherProvince,
} from './types';
