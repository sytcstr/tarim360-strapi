import { createHash } from 'node:crypto';
import type {
  AgriWeatherRecord,
  WeatherProvince,
} from './types';

const finiteNumber = (value: unknown, field: string): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be finite`);
  return parsed;
};

const utcIso = (value: unknown): string => {
  const raw = String(value ?? '').trim();
  if (!raw) throw new Error('Open-Meteo current.time is required');
  const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) ? raw : `${raw}Z`;
  const date = new Date(withZone);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid forecast time');
  return date.toISOString();
};

export const normalizeOpenMeteoPayload = ({
  payload,
  province,
  fetchedAt,
  sourceUrl,
}: {
  payload: unknown;
  province: WeatherProvince;
  fetchedAt: Date;
  sourceUrl: string;
}): AgriWeatherRecord => {
  const root = payload as Record<string, unknown>;
  const current = root?.current as Record<string, unknown> | undefined;
  if (!current) throw new Error('Open-Meteo current payload is missing');

  const precipitation = finiteNumber(
    current.precipitation ?? 0,
    'precipitation',
  );
  const windSpeed = finiteNumber(current.wind_speed_10m, 'windSpeed');
  if (precipitation < 0 || windSpeed < 0) {
    throw new Error('Precipitation and wind speed cannot be negative');
  }

  const rawHumidity = current.relative_humidity_2m;
  const humidity =
    rawHumidity === null || rawHumidity === undefined
      ? null
      : finiteNumber(rawHumidity, 'humidity');
  if (humidity !== null && (humidity < 0 || humidity > 100)) {
    throw new Error('Humidity must be between 0 and 100');
  }

  const fetchedAtIso = fetchedAt.toISOString();
  return {
    province,
    temperature: finiteNumber(current.temperature_2m, 'temperature'),
    precipitation,
    windSpeed,
    humidity: humidity === null ? null : Math.round(humidity),
    forecastAt: utcIso(current.time),
    fetchedAt: fetchedAtIso,
    expiresAt: new Date(fetchedAt.getTime() + 4 * 60 * 60 * 1000).toISOString(),
    sourceName: 'Open-Meteo',
    sourceUrl,
  };
};

export const buildWeatherDedupeKey = (record: AgriWeatherRecord): string => {
  const identity = [
    record.province.id,
    record.sourceName.toLocaleLowerCase('en-US'),
    new Date(record.forecastAt).toISOString(),
  ].join('|');
  return createHash('sha256').update(identity).digest('hex');
};
