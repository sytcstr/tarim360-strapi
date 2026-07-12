import type { Core } from '@strapi/strapi';
import type {
  AgriWeatherPersister,
  WeatherProvince,
} from './types';

const PROVINCE_UID = 'api::province.province';
const WEATHER_UID = 'api::agri-weather-cache.agri-weather-cache';

export const loadWeatherProvinces = async (
  strapi: Core.Strapi,
): Promise<WeatherProvince[]> => {
  const rows = await strapi.db.query(PROVINCE_UID as any).findMany({
    where: { isActive: true },
  } as any);
  return (Array.isArray(rows) ? rows : [])
    .map((row: any) => ({
      id: Number(row.id),
      documentId: String(row.documentId ?? '').trim() || undefined,
      name: String(row.name ?? '').trim(),
      slug: String(row.slug ?? '').trim(),
      latitude: Number(row.latitude),
      longitude: Number(row.longitude),
    }))
    .filter(
      (province) =>
        Number.isInteger(province.id) &&
        province.id > 0 &&
        province.name.length > 0 &&
        Number.isFinite(province.latitude) &&
        Number.isFinite(province.longitude),
    );
};

export const createStrapiWeatherPersister = (
  strapi: Core.Strapi,
): AgriWeatherPersister => async (record) => {
  const query = strapi.db.query(WEATHER_UID as any);
  const existing = await query.findOne({
    where: { dedupeKey: record.dedupeKey },
  } as any);
  if (existing) return 'duplicate';

  try {
    await query.create({
      data: {
        province: record.province.id,
        latitude: record.province.latitude,
        longitude: record.province.longitude,
        temperature: record.temperature,
        precipitation: record.precipitation,
        windSpeed: record.windSpeed,
        humidity: record.humidity,
        forecastAt: record.forecastAt,
        fetchedAt: record.fetchedAt,
        expiresAt: record.expiresAt,
        sourceName: record.sourceName,
        sourceUrl: record.sourceUrl,
        dedupeKey: record.dedupeKey,
      },
    } as any);
    return 'created';
  } catch (error) {
    const concurrent = await query.findOne({
      where: { dedupeKey: record.dedupeKey },
    } as any);
    if (concurrent) return 'duplicate';
    throw error;
  }
};
