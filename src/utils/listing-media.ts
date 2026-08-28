import type { Core } from '@strapi/strapi';
import { matchesIdentity, type SessionIdentity } from './identity';

const LISTING_UID = 'api::listing.listing';
const UPLOAD_FILE_UID = 'plugin::upload.file';

const asPositiveInt = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * LISTING_L13_MEDIA_LIFECYCLE_REPORT.md. Extracts the real Strapi Upload
 * file ids a client sent for a listing's `photos` field, from whatever
 * shape the request body carries them in (a plain array of ids/numeric
 * strings, or the more verbose `{id: ...}`-object-per-entry shape some
 * Strapi client libraries send). Never trusts a URL string as identity
 * (L13.2) -- only a real, positive-integer file id counts.
 */
export const extractRequestedPhotoIds = (rawPhotos: unknown): number[] => {
  if (!Array.isArray(rawPhotos)) return [];
  const ids: number[] = [];
  for (const entry of rawPhotos) {
    const id = asPositiveInt(
      entry && typeof entry === 'object' ? (entry as Record<string, unknown>).id : entry,
    );
    if (id !== null) ids.push(id);
  }
  return ids;
};

/**
 * L13.3: resolves whose listing (if any) a given upload file id is
 * CURRENTLY attached to, via Strapi's own built-in `related` morphToMany
 * relation on `plugin::upload.file` -- never a raw SQL/table-name
 * assumption, and never scoped to only the `listing` content-type, since
 * the same file pool is shared by profile-setting avatar/cover and
 * several other content-types (L13.10). Returns `null` if the file
 * doesn't exist, or isn't currently attached to any listing.
 */
const findAttachingListingIdentity = async (
  strapi: Core.Strapi,
  fileId: number,
): Promise<SessionIdentity | null> => {
  const file = await strapi.entityService.findOne(UPLOAD_FILE_UID as any, fileId, {
    populate: ['related'],
  } as any);
  const related = (file as any)?.related;
  if (!Array.isArray(related)) return null;

  for (const rel of related) {
    if (!rel || rel.__type !== LISTING_UID) continue;
    const listingId = rel.id;
    if (listingId === undefined || listingId === null) continue;
    const row = await strapi.entityService.findOne(LISTING_UID as any, listingId, {
      fields: ['ownerEmail', 'ownerProfileId', 'ownerId'],
    } as any);
    if (!row) continue;
    const email = String((row as any).ownerEmail ?? '').trim().toLowerCase();
    const ownerId = String((row as any).ownerProfileId ?? (row as any).ownerId ?? '').trim();
    if (email || ownerId) return { email, ownerId };
  }
  return null;
};

/**
 * L13.3: a file id is safe for `identity` to attach to their OWN listing
 * when it is either (a) not currently attached to ANY listing at all
 * (a freshly-uploaded file nobody has claimed yet), or (b) already
 * attached to a listing THIS SAME identity owns (re-saving your own
 * existing photo, or an owner editing one of their other listings).
 * Rejects only the confirmed real attack this phase's forensic found:
 * attaching a file that is CURRENTLY visibly used on someone ELSE's
 * live listing.
 */
export const isPhotoOwnedByIdentity = async (
  strapi: Core.Strapi,
  fileId: number,
  identity: SessionIdentity,
): Promise<boolean> => {
  const attachedTo = await findAttachingListingIdentity(strapi, fileId);
  if (!attachedTo) return true;
  return matchesIdentity(
    { ownerEmail: attachedTo.email, ownerProfileId: attachedTo.ownerId },
    identity,
    ['ownerEmail'],
    ['ownerProfileId'],
  );
};

/**
 * L13.10: true if `fileId` is referenced by ANY entity other than the
 * listing identified by `excludeDocumentId` -- across every content-type
 * that shares the same upload-file pool (profile-setting avatar/cover,
 * hub-content, processed-product, etc. all resolve generically here,
 * since `related` is populated by Strapi itself, not enumerated by hand
 * per content-type). A listing's own draft+published row pair (this
 * content-type's `draftAndPublish:true` duplication) both count as "the
 * same listing", not a second reference, since both share
 * `excludeDocumentId`.
 */
export const isFileReferencedElsewhere = async (
  strapi: Core.Strapi,
  fileId: number,
  excludeDocumentId: string,
): Promise<boolean> => {
  const file = await strapi.entityService.findOne(UPLOAD_FILE_UID as any, fileId, {
    populate: ['related'],
  } as any);
  const related = (file as any)?.related;
  if (!Array.isArray(related) || related.length === 0) return false;

  for (const rel of related) {
    if (!rel) continue;
    if (rel.__type === LISTING_UID) {
      const relId = rel.id;
      if (relId !== undefined && relId !== null) {
        const row = await strapi.entityService.findOne(LISTING_UID as any, relId, {
          fields: ['documentId'],
        } as any);
        if (row && (row as any).documentId === excludeDocumentId) continue;
      }
    }
    return true;
  }
  return false;
};

/**
 * L13.17: Strapi's schema-level `allowedTypes: ["images"]` restriction on
 * the `photos` field is only enforced by the upload plugin's own
 * upload-with-ref flow (POST /api/upload with ref/refId/field) -- confirmed
 * live that it is NOT enforced when a file id already sitting in
 * plugin::upload.file (uploaded generically, then connected via a normal
 * listing create/update relation payload) is attached this way, since
 * Strapi's relation-connect at that layer only checks the id exists, never
 * the target field's allowedTypes. Returns the first requested file id
 * whose stored `mime` isn't an image type, or null if all are images (a
 * nonexistent file id is left for the relation-connect step itself to
 * reject, not this check's concern).
 */
export const findNonImageFileId = async (
  strapi: Core.Strapi,
  fileIds: number[],
): Promise<number | null> => {
  for (const fileId of fileIds) {
    const file = await strapi.entityService.findOne(UPLOAD_FILE_UID as any, fileId, {
      fields: ['mime'],
    } as any);
    if (!file) continue;
    const mime = String((file as any)?.mime ?? '');
    if (!mime.startsWith('image/')) return fileId;
  }
  return null;
};

/**
 * L13.7/L13.8/L13.9: physically deletes a file via the upload plugin's
 * own service (never the public `DELETE /api/upload/files/:id` HTTP
 * route -- see L13.3's separate finding that route has no ownership
 * check for ANY authenticated user; this app's own cleanup never needs
 * it, since it always runs server-side with strapi's own service
 * directly) -- but ONLY once confirmed not referenced elsewhere.
 * Never throws: a cleanup failure must not fail the listing operation
 * it's attached to (L13.23) -- logged via strapi.log.warn instead.
 */
export const cleanupOrphanedPhotoIds = async (
  strapi: Core.Strapi,
  fileIds: number[],
  excludeDocumentId: string,
): Promise<void> => {
  for (const fileId of fileIds) {
    try {
      const referencedElsewhere = await isFileReferencedElsewhere(
        strapi,
        fileId,
        excludeDocumentId,
      );
      if (referencedElsewhere) continue;
      const file = await strapi.entityService.findOne(UPLOAD_FILE_UID as any, fileId, {} as any);
      if (!file) continue;
      await strapi.plugin('upload').service('upload').remove(file);
    } catch (e) {
      strapi.log.warn(`Orphaned listing photo cleanup failed for file ${fileId}: ${String(e)}`);
    }
  }
};
