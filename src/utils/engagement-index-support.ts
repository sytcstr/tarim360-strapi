/**
 * Dialect-portable existence check for a named unique DB index, used by
 * src/index.ts's `ensureEngagementUniqueIndexes` bootstrap hook.
 *
 * Production incident (post D-final release): the original implementation
 * ran a hand-written `knex.raw('PRAGMA index_list(...)')` to check for an
 * existing index. PRAGMA is SQLite-only syntax -- it worked in every local
 * verification (this project's tests always boot against a throwaway
 * SQLite DB) but crashed Strapi Cloud's boot with a raw SQL syntax error,
 * because production runs a different DB dialect than local dev/test.
 *
 * Fix: delegate entirely to Strapi's own per-dialect schema inspector
 * (`db.dialect.schemaInspector.getIndexes`) -- the exact mechanism Strapi
 * itself uses internally for schema diffing, already correct per dialect
 * (SQLite: PRAGMA index_list/index_info under the hood; PostgreSQL:
 * pg_catalog/information_schema; MySQL: information_schema). This code
 * never writes its own dialect-specific SQL, so it cannot run the wrong
 * dialect's query by construction -- there is no manual branch to get
 * wrong.
 */
export interface DialectIndexSource {
  dialect: {
    client: string;
    schemaInspector: {
      getIndexes(tableName: string): Promise<Array<{ name?: string }>>;
    };
  };
}

export const hasUniqueIndex = async (
  db: DialectIndexSource,
  table: string,
  indexName: string,
): Promise<boolean> => {
  const indexes = await db.dialect.schemaInspector.getIndexes(table);
  if (!Array.isArray(indexes)) {
    // Never silently treat an unreadable result as "index missing" --
    // that would risk re-issuing a CREATE against an index that already
    // exists (or, worse, masking a real problem as a false negative).
    throw new Error(
      `dialect.schemaInspector.getIndexes(${table}) returned a non-array result -- cannot verify unique index state.`,
    );
  }
  return indexes.some((index) => index?.name === indexName);
};
