/**
 * PUB-PROFILE-B — narrow, allowlisted public profile read.
 *
 * Same canonical id as D8-V-B's /profile-view-target: Flutter only ever
 * knows a profile by ownerId (== profile-setting.profileId,
 * u_<sanitized-email>). This resolves the SAME row, keyed the SAME way
 * (findMany by profileId, limit:2 ambiguity guard, unique constraint at
 * the schema level) -- one identity system, two narrow, purpose-specific
 * field projections (this one for public display, engagement-profile-
 * lookup.ts for the view-target row id). Neither depends on the other;
 * global::profile-setting-ownership is never involved (that policy's own
 * GET-list branch was the SEC-1 bug -- this endpoint does its own direct,
 * narrow db.query, same as engagement-profile-lookup.ts).
 *
 * Field allowlist -- grounded in what the app actually reads for a
 * NON-owner profile view today (business_vertical_store.dart's
 * _applyRemoteProfileSettingsToUser, and hesabim_page.dart's `!_isOwnerView`
 * branch), not guessed:
 *   displayName, publicUsername, brandName, city, bio, aboutText,
 *   logisticsAboutText, accountType, avatarUrl, coverUrl, coverFocusY/
 *   avatarZoom (from profileMediaSettings), showcasePinnedIds/
 *   showcasePinnedOrder (the visitor-facing listing curation/order --
 *   read only in the `!_isOwnerView` branch), and a computed rating
 *   average/count (never the raw per-viewer vote map).
 *
 * Deliberately EXCLUDED even though the app currently reads them for
 * ANY viewer (a pre-SEC-1 side effect of the same bypass, not a
 * considered public/private decision): phone, whatsapp, birthDate.
 * These are personal contact/PII fields; exposing them to any caller
 * who knows/guesses an ownerId is not something this phase reintroduces.
 * Also excluded: activeModules/businessModules/disabledBusinessModules
 * (their availability computation is entangled with activePremium/
 * activePremiumSubscription, which must stay private) -- business-
 * vertical sections on a viewed profile may not reflect the owner's
 * active modules until a dedicated, deliberately public "which modules
 * are active" signal is designed. "Herkese açık ilan sayısı" from the
 * field inventory is also not implemented here: it is not a
 * profile-setting field at all (it would require aggregating other
 * content-types by owner), out of this endpoint's scope.
 *
 * PROFILE_RELEASE_AUDIT.md / BUG-002: `activePremium`/
 * `activePremiumSubscription` themselves stay private (selected here
 * only to feed `isPremiumActiveFromProfile`, never spread into the
 * response), but the single computed boolean they resolve to -- is this
 * owner currently premium, yes or no -- is exactly as public as a
 * "verified" badge and was wrongly withheld entirely. Flutter's own
 * visitor-view code was reduced to guessing via `accountType ===
 * 'premium'`, a value nothing in this codebase ever writes. `isPremium`
 * closes that gap using the exact same canonical rule every other
 * premium gate in this backend already uses -- no new business rule.
 */
import { TARGET_UID } from '../../../utils/engagement-contract';
import { isPremiumActiveFromProfile } from '../../../utils/premium-sync';

const PROFILE_UID = TARGET_UID.profile;

const SELECT_FIELDS = [
  'profileId',
  'displayName',
  'publicUsername',
  'brandName',
  'city',
  'bio',
  'aboutText',
  'logisticsAboutText',
  'accountType',
  'avatarUrl',
  'coverUrl',
  'profileMediaSettings',
  'showcasePinnedIds',
  'showcasePinnedOrder',
  'ratingBaseCount',
  'voteCountBase',
  'ratingBaseAverage',
  'ratingAverageBase',
  'ratingVotesByViewer',
  'ratingVotes',
  // Selected ONLY to feed isPremiumActiveFromProfile below -- never
  // spread into PublicProfileFields / the response body.
  'activePremium',
  'activePremiumSubscription',
] as const;

export interface PublicProfileFields {
  ownerId: string;
  displayName: string;
  publicUsername: string;
  brandName: string;
  city: string;
  bio: string;
  aboutText: string;
  logisticsAboutText: string;
  accountType: string;
  avatarUrl: string;
  coverUrl: string;
  coverFocusY: number;
  avatarZoom: number;
  showcasePinnedIds: string[];
  showcasePinnedOrder: string;
  ratingAverage: number;
  ratingCount: number;
  isPremium: boolean;
}

export interface PublicProfileResult {
  found: boolean;
  ambiguous: boolean;
  profile: PublicProfileFields | null;
}

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v).trim());

const num = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Mirrors ProfileRatingStore.average()/totalCount() (Flutter) exactly:
 * base (seed) count/average combined with the dynamic per-viewer votes --
 * only the resulting two numbers are ever exposed, never the vote map
 * itself (which ties individual viewer identities to individual votes). */
const computeRating = (row: Record<string, any>): { average: number; count: number } => {
  const baseCount = Math.max(0, num(row.ratingBaseCount ?? row.voteCountBase, 0));
  const baseAverage = Math.min(5, Math.max(0, num(row.ratingBaseAverage ?? row.ratingAverageBase, 0)));
  const votesRaw = row.ratingVotesByViewer ?? row.ratingVotes;
  const votes: number[] =
    votesRaw && typeof votesRaw === 'object'
      ? Object.values(votesRaw)
          .map((v) => num(v, 0))
          .filter((v) => v > 0)
      : [];
  const count = baseCount + votes.length;
  if (count <= 0) return { average: 0, count: 0 };
  const dynamicSum = votes.reduce((a, b) => a + b, 0);
  const average = (baseAverage * baseCount + dynamicSum) / count;
  return { average: Math.min(5, Math.max(0, average)), count };
};

export const resolvePublicProfile = async (
  strapiInstance: any,
  ownerId: string,
): Promise<PublicProfileResult> => {
  const id = String(ownerId ?? '').trim();
  if (!id) return { found: false, ambiguous: false, profile: null };

  const rows = await strapiInstance.db.query(PROFILE_UID).findMany({
    where: { profileId: id },
    select: [...SELECT_FIELDS],
    limit: 2,
  });

  if (!rows || rows.length === 0) return { found: false, ambiguous: false, profile: null };

  if (rows.length > 1) {
    strapiInstance.log.error(
      `[public-profile] ambiguous profileId "${id}": ${rows.length} profile-setting rows matched (expected the unique constraint to make this impossible).`,
    );
    return { found: false, ambiguous: true, profile: null };
  }

  const row = rows[0];
  const mediaSettingsRaw = row.profileMediaSettings;
  const mediaSettings = mediaSettingsRaw && typeof mediaSettingsRaw === 'object' ? mediaSettingsRaw : {};
  const { average, count } = computeRating(row);

  return {
    found: true,
    ambiguous: false,
    profile: {
      ownerId: str(row.profileId),
      displayName: str(row.displayName),
      publicUsername: str(row.publicUsername),
      brandName: str(row.brandName),
      city: str(row.city),
      bio: str(row.bio),
      aboutText: str(row.aboutText) || str(row.bio),
      logisticsAboutText: str(row.logisticsAboutText),
      accountType: str(row.accountType) || 'standard',
      avatarUrl: str(row.avatarUrl),
      coverUrl: str(row.coverUrl),
      coverFocusY: num(mediaSettings.coverFocusY, 0),
      avatarZoom: num(mediaSettings.avatarZoom, 1),
      showcasePinnedIds: Array.isArray(row.showcasePinnedIds)
        ? row.showcasePinnedIds.map((v: unknown) => str(v)).filter((v: string) => v.length > 0)
        : [],
      showcasePinnedOrder: str(row.showcasePinnedOrder),
      ratingAverage: average,
      ratingCount: count,
      isPremium: isPremiumActiveFromProfile(row),
    },
  };
};
