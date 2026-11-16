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
 * birthDate stays EXCLUDED even though the app currently reads it for
 * ANY viewer (a pre-SEC-1 side effect of the same bypass, not a
 * considered public/private decision) -- a personal PII field with no
 * opt-in visibility control, not something this phase reintroduces.
 *
 * LISTING_L7_SELLER_CONTACT_PRIVACY_REPORT.md L7.3/L7.4: phone/whatsapp
 * used to be excluded unconditionally too, for the same reason. They are
 * now included ONLY when the owner has explicitly opted in via
 * `contactPhoneVisible`/`contactWhatsappVisible` (both default false --
 * a profile that has never touched this setting stays exactly as
 * private as before this phase). The raw phone/whatsapp column is never
 * selected/spread when the corresponding flag is off; there is no
 * client-facing distinction between "no phone on file" and "has a phone
 * but chose not to show it" -- both simply omit the field.
 * The raw activeModules/businessModules/disabledBusinessModules/
 * activePremium/activePremiumSubscription columns stay excluded (their
 * availability computation is entangled with premium plan/price/dates,
 * which must stay private) -- but `activeBusinessVerticals` below is now
 * the dedicated, deliberately public "which modules are active" signal
 * this comment used to say was still missing: just the resulting
 * canonical vertical codes (`islenmis_urunler`/`lojistik`), computed the
 * same way require-logistics-premium.ts's policy already does, never the
 * private columns that feed it. Business_vertical_store.dart's
 * activeModulesFor() previously had no way to resolve module state for
 * any owner other than the current session, so a visitor viewing someone
 * else's profile always saw every business-vertical section as inactive
 * regardless of the real owner's state -- this closes that gap.
 * "Herkese açık ilan sayısı" from the field inventory is also not
 * implemented here: it is not a profile-setting field at all (it would
 * require aggregating other content-types by owner), out of this
 * endpoint's scope.
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
  'phone',
  'whatsapp',
  'contactPhoneVisible',
  'contactWhatsappVisible',
  'profileMediaSettings',
  'showcasePinnedIds',
  'showcasePinnedOrder',
  'ratingBaseCount',
  'voteCountBase',
  'ratingBaseAverage',
  'ratingAverageBase',
  'ratingVotesByViewer',
  'ratingVotes',
  // Soru/Profil/Kart denetimi Madde 15/16 (düzeltme): follower/following
  // COUNTS only (never the raw id lists -- those stay as private as the
  // per-viewer rating vote map above). This is now ALWAYS the real,
  // VERIFIED followerIds/followingIds length -- NOT blended with
  // followersFallback/followingFallback at all (those are intentionally
  // not selected here anymore). A prior version of this fix used
  // max(real, fallback), which meant a genuine unfollow against a
  // profile with a large legacy fallback barely moved the shown number
  // and -- more importantly -- let an unverified, pre-fix,
  // client-writable historic guess be PRESENTED as if it were a real,
  // verified follower total forever. That was wrong: the fallback is
  // not verifiable data (its individual composition is unknown and it
  // was writable by the client before Madde 17/18's strip), so it must
  // never be the number shown as "doğrulanabilir takip ilişkileri".
  // KNOWN, DISCLOSED CONSEQUENCE: any profile that only has historic,
  // pre-fix followers (never re-confirmed through followProfile) will
  // show a VISIBLY LOWER public follower count than before this change
  // -- this is intentional and correct (the old number was never a
  // verified count), not a bug. followersFallback/followingFallback
  // themselves are left exactly as stored in production (never read,
  // written, deleted, or migrated here) -- they simply stop being
  // blended into the PUBLIC-facing total.
  'followerIds',
  'followingIds',
  // Soru/Profil/Kart denetimi Madde 13 (yorumların gerçek okuma akışı):
  // completes the EXISTING "Yorumlar" tab, which already renders
  // whatever incomingForProfile(profileId) returns for ANY viewer (owner
  // or visitor) with no follower-gating/block-list of any kind anywhere
  // in this codebase (confirmed by reading profile_comments_store.dart,
  // hesabim_page.dart's `_isOwnerView` branch, and this controller --
  // none of them restrict WHO can see a comment, only how the OWNER's
  // own management UI differs from a visitor's composer UI) -- so this
  // mirrors the exact same guest-reachable access model as every other
  // field in this response (`auth:false` on the route), never a new
  // visibility rule. Redacted below (fromEmail/operationId/fingerprint
  // never leave this service).
  'incomingProfileComments',
  'incomingComments',
  // Selected ONLY to feed isPremiumActiveFromProfile below -- never
  // spread into PublicProfileFields / the response body.
  'activePremium',
  'activePremiumSubscription',
  // Selected ONLY to compute `activeBusinessVerticals` below (the raw
  // columns themselves never leave this service) -- the "dedicated,
  // deliberately public 'which modules are active' signal" this file's
  // own header comment said was missing. Without it, business_vertical_
  // store.dart's activeModulesFor() has no way to resolve module state
  // for any owner OTHER than the current session (it only ever loads
  // local prefs + a remote fetch for "me") -- so a visitor opening
  // someone else's profile always saw İşlenmiş Ürünler/Nakliye & Lojistik
  // as inactive regardless of the real owner's state, hiding those
  // sections even when the owner has real products/vehicles/loads.
  'businessModules',
  'activeModules',
  'disabledBusinessModules',
] as const;

/** Mirrors require-logistics-premium.ts's own toList/normalizeModule --
 * same shape, kept local here (that policy file has no exports) rather
 * than risking a shared-util refactor touching an already-tested write
 * path for this read-only addition. */
const toModuleList = (value: unknown): unknown[] => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') return Object.values(parsed as Record<string, unknown>);
    } catch (_) {
      return value.split(',');
    }
  }
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>);
  return [];
};

const normalizeModuleKey = (value: unknown): string => {
  if (value == null) return '';
  if (typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return String(row.code || row.key || row.id || row.name || '').trim().toLowerCase();
  }
  return String(value).trim().toLowerCase();
};

// Same alias sets business_vertical_store.dart's _decode() accepts for
// each vertical, so a module string written by either side of the sync
// path is recognized the same way here.
const PROCESSED_MODULE_KEYS = new Set([
  'processed',
  'processed_products',
  'processed_products_store',
  'islenmis_urunler',
]);
const LOGISTICS_MODULE_KEYS = new Set(['logistics', 'lojistik', 'nakliye', 'nakliyat']);

const hasAnyModule = (row: Record<string, any>, keys: Set<string>): boolean => {
  const modules = [...toModuleList(row?.activeModules), ...toModuleList(row?.businessModules)];
  return modules.some((item) => keys.has(normalizeModuleKey(item)));
};

const isModuleDisabled = (row: Record<string, any>, keys: Set<string>): boolean => {
  const disabled = toModuleList(row?.disabledBusinessModules);
  return disabled.some((item) => keys.has(normalizeModuleKey(item)));
};

/** business_vertical_store.dart's own canonical encode() strings --
 * `kIncludedPremiumBusinessVerticals`'s rule (active premium alone makes
 * BOTH verticals "active" regardless of the explicit module list) is
 * mirrored here via the `premiumActive ||` branch, then disabled-list
 * gates either one off exactly like disabledModulesFor()'s own
 * `entitled.where((v) => !disabled.contains(v))`. */
const computeActiveBusinessVerticals = (row: Record<string, any>, premiumActive: boolean): string[] => {
  const out: string[] = [];
  const processedOn = premiumActive || hasAnyModule(row, PROCESSED_MODULE_KEYS);
  if (processedOn && !isModuleDisabled(row, PROCESSED_MODULE_KEYS)) out.push('islenmis_urunler');
  const logisticsOn = premiumActive || hasAnyModule(row, LOGISTICS_MODULE_KEYS);
  if (logisticsOn && !isModuleDisabled(row, LOGISTICS_MODULE_KEYS)) out.push('lojistik');
  return out;
};

export interface PublicProfileComment {
  id: string;
  fromName: string;
  fromProfileId: string;
  avatarUrl: string;
  text: string;
  timeText: string;
  rating: number;
}

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
  phone?: string;
  whatsapp?: string;
  coverFocusY: number;
  avatarZoom: number;
  showcasePinnedIds: string[];
  showcasePinnedOrder: string;
  ratingAverage: number;
  ratingCount: number;
  followerCount: number;
  followingCount: number;
  comments: PublicProfileComment[];
  isPremium: boolean;
  activeBusinessVerticals: string[];
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
/** Soru/Profil/Kart denetimi Madde 15/16 (düzeltme): the real, VERIFIED
 * follow relationship count -- ONLY the real followerIds/followingIds
 * array length, never blended with the legacy followersFallback/
 * followingFallback counter (see this function's callers' own SELECT_FIELDS
 * comment for the full reasoning: the fallback is not verifiable data
 * and must never be presented as if it were the real total). */
const computeFollowCount = (idsRaw: unknown): number => {
  const ids = Array.isArray(idsRaw) ? new Set(idsRaw.map((v) => String(v ?? '').trim()).filter(Boolean)) : new Set();
  return ids.size;
};

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

// The real uploaded photo lives in the `avatarImage`/`coverImage` MEDIA
// RELATIONS (profile-setting schema), written by profile_edit_page.dart's
// upload flow (`payload['avatarImage'] = avatarUploadId`). `avatarUrl`/
// `coverUrl` are separate, plain string columns that nothing in this
// backend ever writes to -- they stay empty forever. Same root cause and
// same fix shape as UAT #1's `listing-popular-query.ts` `photos` gap:
// `db.query` (the low-level Query Engine), unlike entityService/the
// normal find pipeline, never auto-populates a relation unless it is
// named in `populate`. Selecting the dead string column was therefore
// never going to surface a real avatar for anyone but the profile owner
// (whose OWN device reads `avatarImage` correctly via a different,
// already-populated query in strapi_service.dart).
const MEDIA_POPULATE = { avatarImage: true, coverImage: true } as any;

const mediaUrl = (media: unknown): string => {
  if (!media || typeof media !== 'object') return '';
  return str((media as Record<string, unknown>).url);
};

/** Soru/Profil/Kart denetimi Madde 13: redacts every entry -- fromEmail
 * (PII) and operationId/fingerprint (internal idempotency bookkeeping,
 * never meant to be public) are dropped; only the fields the "Yorumlar"
 * tab actually renders are kept. An entry with no real text/fromName is
 * skipped (matches ProfileCommentsStore._toProfileCommentList's own
 * Flutter-side validation, so a malformed historic entry can't render
 * as a blank comment on either side). */
const toPublicComments = (raw: unknown): PublicProfileComment[] => {
  if (!Array.isArray(raw)) return [];
  const out: PublicProfileComment[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const map = entry as Record<string, unknown>;
    const fromName = str(map.fromName);
    const text = str(map.text);
    if (!fromName || !text) continue;
    out.push({
      id: str(map.id),
      fromName,
      fromProfileId: str(map.fromProfileId),
      avatarUrl: str(map.avatarUrl),
      text,
      timeText: str(map.timeText) || 'Şimdi',
      rating: Math.max(0, Math.min(5, num(map.rating, 0))),
    });
  }
  return out;
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
    populate: MEDIA_POPULATE,
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
  const phone = str(row.phone);
  const whatsapp = str(row.whatsapp);
  const premiumActive = isPremiumActiveFromProfile(row);

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
      // Prefer the real uploaded media's URL; the plain string columns
      // are kept as a fallback only (nothing writes them today, but this
      // stays correct if that ever changes instead of silently ignoring
      // a future legitimate write).
      avatarUrl: mediaUrl(row.avatarImage) || str(row.avatarUrl),
      coverUrl: mediaUrl(row.coverImage) || str(row.coverUrl),
      // Omitted entirely (not an empty string) unless the owner opted in
      // AND actually has a value on file -- a caller must never be able
      // to distinguish "opted out" from "no number on file" from the
      // response shape, both just omit the key.
      ...(row.contactPhoneVisible === true && phone ? { phone } : {}),
      ...(row.contactWhatsappVisible === true && whatsapp ? { whatsapp } : {}),
      coverFocusY: num(mediaSettings.coverFocusY, 0),
      avatarZoom: num(mediaSettings.avatarZoom, 1),
      showcasePinnedIds: Array.isArray(row.showcasePinnedIds)
        ? row.showcasePinnedIds.map((v: unknown) => str(v)).filter((v: string) => v.length > 0)
        : [],
      showcasePinnedOrder: str(row.showcasePinnedOrder),
      ratingAverage: average,
      ratingCount: count,
      followerCount: computeFollowCount(row.followerIds),
      followingCount: computeFollowCount(row.followingIds),
      comments: toPublicComments(row.incomingProfileComments ?? row.incomingComments),
      isPremium: premiumActive,
      activeBusinessVerticals: computeActiveBusinessVerticals(row, premiumActive),
    },
  };
};
