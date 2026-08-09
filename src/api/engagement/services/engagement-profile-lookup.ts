/**
 * Faz D8-V-B — narrow profile -> engagement-target resolution.
 *
 * Flutter only ever knows a profile by `ownerId` (== `profile-setting`'s
 * own `profileId` field, `u_<sanitized-email>` -- see
 * `utils/identity.ts#ownerIdFromEmail`, which is exactly how
 * `global::profile-setting-ownership` populates `profileId` on create).
 * The generic engagement routes (`resolveTargetRow`,
 * `engagement-core.ts`) only accept a content-type's own Strapi
 * `id`/`documentId` -- never a business key. This service is the one
 * place that bridges the two, and returns ONLY the four fields a view
 * registration needs (documentId, profileId for the self-view check,
 * viewCount, engagementVersion) -- never the full profile-setting
 * document (name, phone, bio, favorites, follow lists, comment blobs,
 * etc. all stay unreachable through this path).
 *
 * `profileId` is `unique: true` at the schema level (see
 * `profile-setting/content-types/profile-setting/schema.json`), so more
 * than one row matching the same `profileId` should be structurally
 * impossible -- `findMany` with `limit: 2` is used anyway (rather than
 * trusting `findOne`) so a genuine constraint violation is reported as
 * an explicit, logged ambiguity instead of silently returning whichever
 * row happens to sort first.
 */
import { TARGET_UID, VERSION_FIELD, VIEW_COUNT_FIELD } from '../../../utils/engagement-contract';

const PROFILE_UID = TARGET_UID.profile;
const VIEW_FIELD = VIEW_COUNT_FIELD.profile;

export interface ProfileViewTargetResult {
  found: boolean;
  ambiguous: boolean;
  documentId: string;
  profileId: string;
  viewCount: number;
  serverVersion: number;
}

const EMPTY_RESULT: ProfileViewTargetResult = {
  found: false,
  ambiguous: false,
  documentId: '',
  profileId: '',
  viewCount: 0,
  serverVersion: 0,
};

export const resolveProfileViewTarget = async (
  strapiInstance: any,
  ownerId: string,
): Promise<ProfileViewTargetResult> => {
  const id = String(ownerId ?? '').trim();
  if (!id || !VIEW_FIELD) return EMPTY_RESULT;

  const rows = await strapiInstance.db.query(PROFILE_UID).findMany({
    where: { profileId: id },
    select: ['documentId', 'profileId', VIEW_FIELD, VERSION_FIELD],
    limit: 2,
  });

  if (!rows || rows.length === 0) return EMPTY_RESULT;

  if (rows.length > 1) {
    strapiInstance.log.error(
      `[profile-view-target] ambiguous profileId "${id}": ${rows.length} profile-setting rows matched (expected the unique constraint to make this impossible).`,
    );
    return { ...EMPTY_RESULT, ambiguous: true };
  }

  const row = rows[0];
  return {
    found: true,
    ambiguous: false,
    documentId: String(row.documentId ?? ''),
    profileId: String(row.profileId ?? ''),
    viewCount: Math.max(0, Number(row[VIEW_FIELD] ?? 0)),
    serverVersion: Number(row[VERSION_FIELD] ?? 0),
  };
};
