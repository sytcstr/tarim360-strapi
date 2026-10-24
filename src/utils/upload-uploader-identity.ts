import type { Core } from '@strapi/strapi';
import { normalizeEmail, readIdentity } from './identity';

const UPLOAD_FILE_UID = 'plugin::upload.file';

/**
 * ILAN OLUSTURMA RAPORU ROUND 3 (item 1): the real, previously-missing
 * piece. isPhotoOwnedByIdentity (listing-media.ts) could only ever verify
 * "not currently attached to someone else's LIVE listing" -- it had no
 * way to tell "I uploaded this" apart from "nobody has claimed this yet",
 * because plugin::upload.file carried no uploader-identity field at all.
 * Confirmed live (round-2 H1/H2/H3 tests) that this let any authenticated
 * user B attach a completely different user A's freshly-uploaded,
 * not-yet-attached photo to B's own listing.
 *
 * Fixed with the SAME narrow extension the user explicitly authorized:
 * src/extensions/upload/content-types/file/schema.json adds one private,
 * non-configurable field (`uploaderEmail`) to the EXISTING upload content
 * type -- no new content-type, no new service. This lifecycle hook
 * stamps it from the server-verified session the moment a file is
 * created, using Strapi's own `requestContext` (the same AsyncLocalStorage-
 * backed mechanism Strapi's core already uses internally for createdBy/
 * updatedBy) -- the client never sends this field, and never could: it
 * is set here, after the request has already been authenticated, from
 * `ctx.state.user`, not from anything in the request body.
 *
 * Email (not a derived ownerId) is stored deliberately: it is the one
 * identity dimension `matchesIdentity`'s own email-comparison path
 * already trusts uniformly everywhere else in this codebase, regardless
 * of whether a given profile's `profileId` happens to be email-derived or
 * a legacy/custom value.
 *
 * GOTCHA (confirmed live, cost real debug time): @strapi/core's plugin
 * extension loader (loaders/plugins/index.js's applyUserExtension) merges
 * an extension schema.json into the plugin's base schema with a SHALLOW
 * `{...baseSchema, ...extendedSchema}` at the schema level -- NOT a deep
 * merge of `attributes`. A schema.json containing only `{"attributes":
 * {"uploaderEmail": ...}}` therefore REPLACES the entire base `attributes`
 * map, silently deleting `related` (the morphToMany every other content-
 * type's media field depends on) and every other built-in file field --
 * this crashed Strapi's own boot-time metadata loader for any unrelated
 * model with a media relation. The extension file must duplicate ALL of
 * plugin::upload.file's base attributes (copied verbatim from
 * @strapi/upload/dist/server/content-types/file.js) alongside the new
 * field, every time. Never shrink this file back down to just the new
 * field.
 */
export const registerUploadFileUploaderLifecycle = (strapi: Core.Strapi) => {
  strapi.db.lifecycles.subscribe({
    models: [UPLOAD_FILE_UID],
    async beforeCreate(event) {
      const ctx = strapi.requestContext.get();
      const identity = ctx ? readIdentity(ctx) : null;
      if (!identity) return;
      event.params.data = {
        ...(event.params.data ?? {}),
        uploaderEmail: identity.email,
      };
    },
  });
};

/**
 * True when `fileId` was genuinely uploaded by `identity` (per the stamp
 * above). False for a file uploaded by someone else, AND for a legacy
 * file that predates this fix (uploaderEmail is null -- an unknown
 * uploader is never treated as "mine", by design: see
 * isPhotoOwnedByIdentity's own doc comment for how this combines with
 * "already attached to one of my own listings", which legacy photos
 * already in use still satisfy).
 */
export const isUploadedByIdentity = async (
  strapi: Core.Strapi,
  fileId: number,
  identity: { email: string },
): Promise<boolean> => {
  const file = await strapi.entityService.findOne(UPLOAD_FILE_UID as any, fileId, {
    fields: ['uploaderEmail'] as any,
  } as any);
  const uploaderEmail = normalizeEmail((file as any)?.uploaderEmail);
  if (!uploaderEmail) return false;
  return uploaderEmail === identity.email;
};
