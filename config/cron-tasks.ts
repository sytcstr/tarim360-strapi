import type { Core } from '@strapi/strapi';
import { runMockAgriDataIngestion } from '../src/services/agri-data-ingestion';

type EnvReader = {
  (key: string, defaultValue?: string): string;
  bool(key: string, defaultValue?: boolean): boolean;
};

type CronTask = (context: { strapi: Core.Strapi }) => Promise<void>;

export default (env: EnvReader) => {
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

  return tasks;
};
