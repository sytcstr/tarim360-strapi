import type { Core } from '@strapi/strapi';
import { runMockAgriDataIngestion } from '../src/services/agri-data-ingestion';
import { runOpenMeteoWeatherIngestion } from '../src/services/agri-weather';

type EnvReader = {
  (key: string, defaultValue?: string): string;
  bool(key: string, defaultValue?: boolean): boolean;
};

type CronTask = (context: { strapi: Core.Strapi }) => Promise<void>;

type CronConfigInput = EnvReader | { env: EnvReader };

export default (input: CronConfigInput) => {
  const env = typeof input === 'function' ? input : input.env;
  const tasks: Record<string, CronTask> = {
    '0 * * * * *': async ({ strapi }) => {
      const now = new Date().toISOString();
      const result = await strapi.db
        .query('api::deleted-account-record.deleted-account-record')
        .deleteMany({
          where: {
            purgeAt: { $lte: now },
          },
        } as any);
      const count = Number((result as any)?.count ?? 0);
      if (count > 0) {
        strapi.log.info(`Expired deleted account records purged: ${count}`);
      }
    },
  };

  if (env.bool('AGRI_INGESTION_ENABLED', false)) {
    const rule = env('AGRI_INGESTION_CRON', '0 */6 * * *').trim();
    if (!rule || Object.prototype.hasOwnProperty.call(tasks, rule)) {
      throw new Error('AGRI_INGESTION_CRON is empty or conflicts with an existing task');
    }
    tasks[rule] = async ({ strapi }) => {
      try {
        const summary = await runMockAgriDataIngestion(strapi);
        strapi.log.info(
          `Agri ingestion completed: received=${summary.received}, created=${summary.created}, duplicates=${summary.duplicates}, invalid=${summary.invalid}`,
        );
      } catch (error) {
        strapi.log.error(`Agri ingestion failed: ${String(error)}`);
      }
    };
  }

  if (env.bool('AGRI_WEATHER_INGESTION_ENABLED', false)) {
    const rule = env('AGRI_WEATHER_INGESTION_CRON', '15 */3 * * *').trim();
    if (!rule || Object.prototype.hasOwnProperty.call(tasks, rule)) {
      throw new Error(
        'AGRI_WEATHER_INGESTION_CRON is empty or conflicts with an existing task',
      );
    }
    tasks[rule] = async ({ strapi }) => {
      const baseUrl = env('OPEN_METEO_BASE_URL', '').trim();
      if (!baseUrl) {
        strapi.log.warn(
          'Open-Meteo ingestion skipped: OPEN_METEO_BASE_URL is not configured',
        );
        return;
      }
      try {
        const summary = await runOpenMeteoWeatherIngestion(strapi, {
          baseUrl,
          apiKey: env('OPEN_METEO_API_KEY', '').trim() || undefined,
        });
        strapi.log.info(
          `Weather ingestion completed: provinces=${summary.provinces}, created=${summary.created}, duplicates=${summary.duplicates}, failed=${summary.failed}`,
        );
      } catch (error) {
        strapi.log.error(`Weather ingestion failed: ${String(error)}`);
      }
    };
  }

  return tasks;
};
