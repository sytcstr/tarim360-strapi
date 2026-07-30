import type { Knex } from 'knex';
import type { Database } from '@strapi/database';

/**
 * Adds the composite unique DB index backing the Engagement API's view
 * dedup record (ENGAGEMENT_API_CONTRACT.md §4.3 — "son görüntülenme
 * kaydı" model). Same defensive, non-throwing hasTable guard and the
 * same known ordering limitation as
 * 2026.07.30T00.00.00.add-engagement-interaction-unique-index.ts —
 * see that file's comment header for the full explanation and the
 * manual recovery steps if the index doesn't end up created after the
 * first deploy.
 */

const TABLE = 'engagement_views';
const INDEX_NAME = 'engagement_views_actor_target_unique';
const COLUMNS = ['actor_key', 'target_type', 'target_id'];

export default {
  async up(knex: Knex, _db: Database) {
    const hasTable = await knex.schema.hasTable(TABLE);
    if (!hasTable) {
      strapi?.log?.warn?.(
        `[engagement migration] ${TABLE} does not exist yet — skipping unique index creation for this boot.`,
      );
      return;
    }
    const hasColumns = await Promise.all(COLUMNS.map((c) => knex.schema.hasColumn(TABLE, c)));
    if (hasColumns.some((present) => !present)) {
      strapi?.log?.warn?.(
        `[engagement migration] ${TABLE} exists but is missing expected columns — skipping.`,
      );
      return;
    }
    const existingIndexes: Array<{ name: string }> = await knex.raw(`PRAGMA index_list(${TABLE})`);
    if (Array.isArray(existingIndexes) && existingIndexes.some((i) => i.name === INDEX_NAME)) {
      return;
    }
    await knex.schema.alterTable(TABLE, (table) => {
      table.unique(COLUMNS, { indexName: INDEX_NAME });
    });
  },

  async down(knex: Knex, _db: Database) {
    const hasTable = await knex.schema.hasTable(TABLE);
    if (!hasTable) return;
    await knex.schema.alterTable(TABLE, (table) => {
      table.dropUnique(COLUMNS, INDEX_NAME);
    });
  },
};
