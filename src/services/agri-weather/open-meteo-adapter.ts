import { normalizeOpenMeteoPayload } from './normalization';
import type {
  AgriWeatherAdapter,
  AgriWeatherRecord,
  WeatherHttpClient,
  WeatherProvince,
} from './types';

const defaultHttpClient: WeatherHttpClient = async (url, init) => {
  const response = await fetch(url, init);
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json(),
  };
};

export class OpenMeteoAdapter implements AgriWeatherAdapter {
  readonly id = 'open-meteo';

  constructor(
    private readonly config: {
      baseUrl: string;
      apiKey?: string;
      timeoutMs?: number;
      httpClient?: WeatherHttpClient;
    },
  ) {}

  async fetch(
    province: WeatherProvince,
    now: Date,
  ): Promise<AgriWeatherRecord> {
    const baseUrl = this.config.baseUrl.trim();
    if (!baseUrl) throw new Error('OPEN_METEO_BASE_URL is not configured');

    const requestUrl = new URL(baseUrl);
    requestUrl.searchParams.set('latitude', String(province.latitude));
    requestUrl.searchParams.set('longitude', String(province.longitude));
    requestUrl.searchParams.set(
      'current',
      'temperature_2m,relative_humidity_2m,precipitation,wind_speed_10m',
    );
    requestUrl.searchParams.set('timezone', 'UTC');
    if (this.config.apiKey?.trim()) {
      requestUrl.searchParams.set('apikey', this.config.apiKey.trim());
    }

    const safeSourceUrl = new URL(requestUrl);
    safeSourceUrl.searchParams.delete('apikey');
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? 10_000,
    );

    try {
      const response = await (this.config.httpClient ?? defaultHttpClient)(
        requestUrl.toString(),
        { signal: controller.signal },
      );
      if (!response.ok) {
        throw new Error(`Open-Meteo request failed with ${response.status}`);
      }
      return normalizeOpenMeteoPayload({
        payload: await response.json(),
        province,
        fetchedAt: now,
        sourceUrl: safeSourceUrl.toString(),
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
