/**
 * LISTING_L13_MEDIA_LIFECYCLE_REPORT.md L13.22 — orphaned upload-file scan.
 *
 * Before this phase, deleting a listing (or removing/replacing one of its
 * photos) never touched the underlying plugin::upload.file row, so any
 * production database older than this phase's create/update/delete
 * cleanup (see src/utils/listing-media.ts) can already hold real orphan
 * files accumulated over time. This script only FINDS and REPORTS them —
 * it never deletes or modifies anything. Any real deletion of files this
 * report lists must be a separate, explicit, user-approved action; this
 * script deliberately does not implement one, per the mandate's "never a
 * blind mass delete" requirement.
 *
 * A file is reported as an orphan when Strapi's own built-in `related`
 * morphToMany relation on plugin::upload.file is empty — i.e. it is not
 * currently attached to ANY row of ANY content-type that shares the
 * upload pool (listing.photos, hub-content, hub-category, agri-product,
 * hub-banner, processed-product, store-document, profile-setting
 * avatar/cover — see listing-media.ts's own header comment for the full
 * list), not just listings. This is the same mechanism
 * isFileReferencedElsewhere already uses for live delete/edit cleanup.
 *
 * Unlike scripts/recount-*-engagement.ts, this script is deliberately NOT
 * refused against a production database — finding orphans that
 * accumulated on the real, already-deployed database is the entire
 * point. It performs no writes at all, so there is nothing for a
 * production guard to protect against.
 *
 * Usage:
 *   npx tsx scripts/scan-orphaned-upload-files.ts [--page-size=200]
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createStrapi, compileStrapi } = require('@strapi/strapi');

const UPLOAD_FILE_UID = 'plugin::upload.file';

async function main(): Promise<void> {
  const pageSizeArg = process.argv.find((a) => a.startsWith('--page-size='));
  const pageSize = pageSizeArg ? Number(pageSizeArg.split('=')[1]) : 200;

  const compiled = await compileStrapi();
  const strapi = await createStrapi(compiled).load();

  try {
    let start = 0;
    let scanned = 0;
    const orphans: Array<{
      id: number;
      name: string;
      size: number;
      createdAt: string;
      url: string;
    }> = [];

    for (;;) {
      // Deliberately NOT entityService.findMany with populate:['related']
      // here -- confirmed live while writing this script that combining a
      // paginated findMany with a populated morphToMany relation hangs
      // (no error, no progress, near-zero CPU) rather than resolving or
      // throwing. Every other `related` read in this codebase
      // (listing-media.ts's isPhotoOwnedByIdentity/isFileReferencedElsewhere)
      // only ever uses findOne, which is the proven-working path -- so
      // this lists bare file rows via db.query first, then populates
      // `related` one file at a time via findOne, same as those.
      const rows: any[] = await strapi.db.query(UPLOAD_FILE_UID).findMany({
        select: ['id', 'name', 'size', 'createdAt', 'url'],
        orderBy: { id: 'asc' },
        offset: start,
        limit: pageSize,
      } as any);
      if (!Array.isArray(rows) || rows.length === 0) break;

      for (const row of rows) {
        scanned++;
        const withRelated = await strapi.entityService.findOne(UPLOAD_FILE_UID as any, row.id, {
          populate: ['related'],
        } as any);
        const related = (withRelated as any)?.related;
        if (!Array.isArray(related) || related.length === 0) {
          orphans.push({
            id: row.id,
            name: row.name,
            size: Number(row.size ?? 0),
            createdAt: String(row.createdAt ?? ''),
            url: String(row.url ?? ''),
          });
        }
      }

      start += rows.length;
      if (rows.length < pageSize) break;
    }

    // eslint-disable-next-line no-console
    console.log(`Scanned ${scanned} upload file row(s).`);
    // eslint-disable-next-line no-console
    console.log(
      `${orphans.length} orphan file(s) found (no related reference on ANY content-type):`,
    );
    for (const o of orphans) {
      // eslint-disable-next-line no-console
      console.log(`  #${o.id}  ${o.name}  ${o.size}KB  created=${o.createdAt}  ${o.url}`);
    }
    if (orphans.length > 0) {
      const totalKb = orphans.reduce((sum, o) => sum + o.size, 0);
      // eslint-disable-next-line no-console
      console.log(
        `Total reclaimable (approx): ${totalKb.toFixed(1)} KB across ${orphans.length} file(s).`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(
      'This script never deletes anything. Review the list above; any real deletion is a separate, explicit action.',
    );
  } finally {
    await strapi.destroy();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Orphan scan failed:', error);
  process.exitCode = 1;
});
