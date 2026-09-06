/**
 * listing controller
 */

import { factories } from '@strapi/strapi';
import { matchesIdentity, normalizeEmail, ownerIdFromEmail, readIdentity } from '../../../utils/identity';
import { isPremiumActiveFromProfile, loadPremiumProfile } from '../../../utils/premium-sync';
import {
  canCreateNextNormalListing,
  findListingByAnyId,
  nextListingNo,
  NORMAL_LISTING_BLOCK_SIZE,
  NORMAL_LISTING_FREE_COUNT,
  stripListingProtectedFields,
} from '../../../utils/listing-metrics';
import { computeListingSearchFields } from '../../../utils/listing-search-fields';
import { buildListingDiscoveryQuery } from '../../../utils/listing-query';
import { fetchPopularListingsPage } from '../../../utils/listing-popular-query';
import { fetchSimilarListingsPage } from '../../../utils/listing-similar-query';
import {
  cleanupOrphanedPhotoIds,
  extractRequestedPhotoIds,
  findNonImageFileId,
  isPhotoOwnedByIdentity,
} from '../../../utils/listing-media';
import { fingerprintPayload, isValidOperationId, resolveOperation } from '../../../utils/operation-idempotency';

const LISTING_UID = 'api::listing.listing';
const PROFILE_UID = 'api::profile-setting.profile-setting';
const PURCHASE_EVENT_UID = 'api::purchase-event.purchase-event';
const ROCKET_ACTIVATION_UID = 'api::rocket-activation.rocket-activation';
const LISTING_CREATE_OPERATION_UID =
  'api::listing-create-operation.listing-create-operation';

const ROCKET_PRODUCT_BY_DAYS: Record<number, string> = {
  7: 'doping_7_189',
  14: 'doping_14_249',
  28: 'doping_28_359',
};
const ROCKET_VALID_DAYS = new Set<number>([
  1, // Kolay Premium's included rocket credit (see PREMIUM_PRODUCTS in purchase/lib/catalog.ts)
  7,
  14,
  28,
]);

const clean = (value: unknown): string => String(value ?? '').trim();

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

// LISTING_AZ_REVALIDATION_PART2_21_40.md Madde 34 (P0): the only
// legitimate reason a caller may see non-active listings through this
// route at all is the owner viewing their OWN "İlanlarım" management
// list (Flutter's `fetchListingsForOwner`, strapi_service.dart) --
// which asks by a raw `filters[<field>][$eq]=<ownerId>` clause, trying
// these three historical owner-identity field names in turn.
const OWNER_IDENTITY_FILTER_FIELDS = ['ownerProfileId', 'ownerId', 'profileId'] as const;

/**
 * Returns the owner-identity field name a raw client filter object is
 * genuinely, verifiably scoped to (its `$eq` value matches the
 * AUTHENTICATED caller's own identity) -- or `null` if the caller isn't
 * authenticated, sent no such clause, or the value belongs to someone
 * else. Deliberately does not just check "is present" -- a caller could
 * send `filters[ownerProfileId][$eq]=<someone else's id>` and would
 * still need to be rejected.
 */
const resolveOwnListingsFilterField = (
  rawFilters: Record<string, unknown>,
  identity: { email: string; ownerId: string },
): (typeof OWNER_IDENTITY_FILTER_FIELDS)[number] | null => {
  for (const field of OWNER_IDENTITY_FILTER_FIELDS) {
    const clause = rawFilters[field];
    if (!isPlainObject(clause)) continue;
    const eqValue = (clause as Record<string, unknown>).$eq;
    if (typeof eqValue === 'string' && eqValue.trim() === identity.ownerId) {
      return field;
    }
  }
  return null;
};

/**
 * SEMANTIC_CONTRACT_S2 (audit finding 2.5): unlike processed-product,
 * logistics-vehicle, and hub-content -- which all strip their engagement-
 * only fields from create/update -- listing.ts had NO update override at
 * all (stock factories.createCoreController), so any authenticated owner
 * could PATCH their own listing's likeCount/favoriteCount/viewCount/
 * offerCount/commentCount/shareCount/engagementVersion to an arbitrary
 * value via a normal PUT /listings/:id. engagement_interactions (via
 * setMembership/incrementCounterAtomic) and listing-metrics.ts's
 * recountListingOffers are the only real sources of truth for these
 * counters now.
 *
 * Also strips isPremium/isPremiumOwner -- the exact same "no update
 * guard" gap, in the exact same controller, letting any owner grant
 * their own listing a premium badge without actually being premium.
 * These are premium-sync.ts-owned, not engagement-v1-owned, but the
 * vulnerability class and the fix are identical; disclosed here rather
 * than silently left in place.
 *
 * LISTING_SYSTEM_RELEASE_FORENSIC_AUDIT.md BUG-LISTING-004: isDoping/
 * rocketEndsAt were previously excluded here ("a separate rocket/
 * promotion mechanism, not part of this audit item"), which meant any
 * listing owner could self-grant a free rocket/boost via a crafted PUT.
 * Now sourced from listing-metrics.ts's LISTING_CLIENT_PROTECTED_FIELDS
 * (shared with engagement.ts's syncOfflineListing, see BUG-LISTING-001),
 * which includes both.
 */
const stripClientProtectedFields = stripListingProtectedFields;

/**
 * A client-supplied `id`/`documentId` must never reach entityService's
 * `data` payload -- confirmed live (LISTING_SYSTEM_RELEASE_FORENSIC_AUDIT.md
 * BUG-LISTING-001 regression testing) that an echoed `id` field can make
 * Strapi attempt to move the row to a different primary key, causing a
 * "UNIQUE constraint failed" error instead of a normal field update. The
 * target row is already selected via the route param / entity lookup;
 * these fields are never legitimate input.
 */
const stripIdentifierFields = (
  data: Record<string, any>,
): Record<string, any> => {
  const next = { ...data };
  delete next.id;
  delete next.documentId;
  return next;
};

/**
 * SEMANTIC_CONTRACT_S1: delegates entirely to premium-sync.ts's canonical
 * rule (missing endsAt = active/unlimited) instead of a separate, stricter
 * local reimplementation (the old version returned false for a missing
 * endsAt, stamping isPremium:false on a brand-new listing for exactly the
 * members the canonical rule -- and premium-sync.ts's own resync of this
 * member's EXISTING listings -- consider active). See
 * SEMANTIC_CONTRACT_S1_CRITICAL_FIX_REPORT.md.
 */
const hasActivePremiumExpiry = (
  profile: Record<string, unknown> | null,
): boolean => isPremiumActiveFromProfile(profile);

const findProfileForIdentity = async (
  strapi: any,
  email: string,
  ownerId: string,
) => {
  const rows = await strapi.entityService.findMany(PROFILE_UID as any, {
    filters: {
      $or: [{ profileId: ownerId }, { ownerEmail: email }],
    },
    fields: [
      'profileId',
      'ownerEmail',
      'activePremium',
      'activePremiumSubscription',
    ],
    limit: 1,
  } as any);
  return (Array.isArray(rows) ? rows[0] : rows) as
    | Record<string, unknown>
    | null;
};

export default factories.createCoreController(
  LISTING_UID,
  ({ strapi }) => ({
    /**
     * LISTING_L6_SERVER_SEARCH_FILTER_SORT_REPORT.md L6.2/L6.14/L6.16:
     * `find` was previously unoverridden -- the stock core action already
     * applies whatever `filters`/`sort`/`pagination` a client sends at the
     * real DB/query level (confirmed live: a pre-existing integration
     * test already proves server-side `mode` filtering works). That's
     * correct, but gives a client free rein to send ANY Strapi filter/
     * sort expression on ANY field, including ones never meant to be
     * client-queryable. This override only activates when the request
     * uses the NEW whitelisted param names (`search`/`listingNo`/
     * `mainType`/`subType`/`mode`/`city`/`district`/`minPrice`/`maxPrice`/
     * `sortBy`/`page`/`pageSize`) -- in that case it REPLACES `ctx.query`
     * with a query built ONLY from those whitelisted fields/operators
     * (any raw `filters[...]`/`sort` also present in the same request is
     * discarded, never merged, so the two styles can't be combined to
     * smuggle an unwhitelisted expression through). If NONE of the new
     * param names are present -- true for every existing/legacy caller,
     * including older app builds that never send them -- `ctx.query` is
     * left completely untouched and `super.find(ctx)` runs exactly as
     * before this phase.
     *
     * LISTING_AZ_REVALIDATION_PART2_21_40.md Madde 34 (P0): the "if none
     * of the new param names are present, leave ctx.query completely
     * untouched" fallback above was itself the vulnerability -- it let a
     * caller send RAW Strapi filter syntax (`filters[status][$eq]=pending`,
     * `filters[status][$ne]=active`, etc.), which uses the DIFFERENT
     * top-level `filters` key this whitelist never inspects, straight
     * through to `super.find(ctx)` with zero status/ownership
     * restriction -- and this route is granted to Strapi's Public role,
     * so no authentication was even required to enumerate every
     * pending/rejected listing's full content. The `else` branch below
     * closes that: raw client filters are NEVER trusted anymore. The one
     * legitimate raw-filter caller (the owner's own "İlanlarım"
     * management view, `fetchListingsForOwner`) is verified against the
     * REQUEST'S OWN authenticated identity and, even then, only a
     * server-rebuilt `{<field>:{$eq:identity.ownerId}}` filter is used --
     * never the client's raw filter object verbatim, so a verified
     * owner-match clause can't be combined with an additional smuggled
     * `$or`/`$ne` to still leak other rows. Every other caller (public,
     * authenticated-but-unrelated, or malformed) always gets a
     * server-built `status:active`-only query, matching the whitelisted
     * discovery path's own guarantee.
     */
    async find(ctx) {
      const discoveryQuery = buildListingDiscoveryQuery(
        (ctx.query ?? {}) as Record<string, unknown>,
      );
      if (discoveryQuery) {
        // LISTING_L12_POPULAR_TRENDING_RANKING_REPORT.md L12.4: `popular`
        // cannot be expressed as a plain field-direction `sort` array (it
        // needs a live rocketEndsAt-vs-now comparison to correctly float
        // ONLY currently-active Rocket listings above everyone else --
        // see listing-popular-query.ts's own header comment) so it's
        // handled as a fully separate response path, never handed to
        // the generic entityService find/sort machinery below.
        if (discoveryQuery.sortBy === 'popular') {
          const { results, pagination } = await fetchPopularListingsPage(
            strapi,
            discoveryQuery.filters,
            discoveryQuery.pagination.page,
            discoveryQuery.pagination.pageSize,
          );
          // Not this.sanitizeOutput/transformResponse here -- confirmed
          // live (same finding this file's create() action already
          // documents) that they don't behave the same way outside the
          // standard entityService-driven find pipeline for a custom
          // action. `fetchPopularListingsPage` reads via the low-level
          // Query Engine (db.query), which does NOT apply Strapi's
          // role-based private-field stripping the way entityService/
          // super.find() normally would -- `ownerEmail` is the one
          // `private: true` field on this content-type, so it must be
          // stripped explicitly here or it would leak into a public
          // response.
          const publicResults = results.map(({ ownerEmail, ...rest }) => rest);
          ctx.body = { data: publicResults, meta: { pagination } };
          return;
        }

        const previous = (ctx.query ?? {}) as Record<string, unknown>;
        ctx.query = {
          filters: discoveryQuery.filters,
          sort: discoveryQuery.sort,
          pagination: discoveryQuery.pagination,
          // Structural/response-shape params are safe to pass through
          // verbatim -- they don't select which rows match, only how
          // each matched row is serialized.
          ...(previous.populate !== undefined
            ? { populate: previous.populate }
            : {}),
          ...(previous.fields !== undefined ? { fields: previous.fields } : {}),
        } as any;
      } else {
        const previous = (ctx.query ?? {}) as Record<string, unknown>;
        const rawFilters = isPlainObject(previous.filters) ? previous.filters : null;
        const identity = readIdentity(ctx);
        const ownField =
          rawFilters && identity
            ? resolveOwnListingsFilterField(rawFilters, identity)
            : null;

        // LISTING_AZ_REVALIDATION_PART2_21_40.md Madde 34 P1 correction:
        // the first version of this fix discarded EVERY non-owner-
        // verified raw filter outright, which also broke legitimate,
        // non-privacy-sensitive raw lookups that predate the whitelisted
        // discovery contract (listing-type-and-public-number.integration.test.ts's
        // `filters[listingNo][$eq]`/`filters[mode][$eq]`,
        // listing-search-filter-sort.integration.test.ts's L6.16 "legacy
        // passthrough" using `filters[title][$containsi]`) -- confirmed
        // live when the full integration suite actually ran those files.
        // AND-wrapping the client's raw filters with a forced
        // `status:active` clause instead preserves all of that while
        // remaining just as safe: Strapi's query engine evaluates `$and`
        // as a hard conjunction, so no nested `$or`/`$ne`/anything the
        // client puts in their own half can ever be satisfied alongside
        // a contradicting status -- at worst it makes their own query
        // return empty, it can never leak a non-active row.
        ctx.query = {
          filters: ownField
            ? { [ownField]: { $eq: identity!.ownerId } }
            : rawFilters
              ? { $and: [{ status: { $eq: 'active' } }, rawFilters] }
              : { status: { $eq: 'active' } },
          // Structural/response-shape/pagination/sort params are safe to
          // pass through verbatim -- they don't select which rows match,
          // only how many/which order/which fields of an already-matched
          // row are returned.
          ...(previous.pagination !== undefined
            ? { pagination: previous.pagination }
            : {}),
          ...(previous.sort !== undefined ? { sort: previous.sort } : {}),
          ...(previous.populate !== undefined
            ? { populate: previous.populate }
            : {}),
          ...(previous.fields !== undefined ? { fields: previous.fields } : {}),
        } as any;
      }
      return super.find(ctx);
    },

    /**
     * LISTING_L14_LIFECYCLE_STATE_MACHINE_REPORT.md L14.14: `findOne` was
     * previously unoverridden -- the stock core action applies NO status
     * filter at all (unlike `find()`'s custom discovery path above), and
     * `api::listing.listing.findOne` is granted to both the Public role
     * AND the Authenticated role (src/index.ts). Confirmed live: a direct
     * `GET /api/listings/:id` for a listing whose `status` is `pending`/
     * `rejected` (currently only reachable via a direct DB write or the
     * Strapi admin panel -- see listing-metrics.ts's own `status` comment)
     * returned its full content to ANY caller, public or not, even though
     * every list/search/popular endpoint already correctly excludes it.
     * This closes that gap the same way `conversation.ts`/
     * `offer-ownership.ts` already gate lifecycle: the listing's owner can
     * always see their own real status (the mandate's own requirement),
     * everyone else gets a plain not-found -- never a 403, which would
     * itself leak "this id exists but is hidden" to a stranger.
     */
    async findOne(ctx) {
      const rawId = String(ctx.params?.id ?? '').trim();
      const row = await findListingByAnyId(strapi, rawId, [
        'id',
        'documentId',
        'status',
        'ownerEmail',
        'ownerProfileId',
        'ownerId',
      ]);
      if (!row) return ctx.notFound('Ilan bulunamadi.');

      const identity = readIdentity(ctx);
      const isOwner =
        !!identity &&
        matchesIdentity(
          row as Record<string, unknown>,
          identity,
          ['ownerEmail'],
          ['ownerProfileId', 'ownerId'],
        );
      const status = String((row as any).status ?? '').trim().toLowerCase();
      if (!isOwner && status !== 'active') {
        return ctx.notFound('Ilan bulunamadi.');
      }
      return super.findOne(ctx);
    },

    /**
     * PRE_UAT_F1_TARGETED_FUNCTIONAL_FIX_REPORT.md F1.6: createListing()
     * had no idempotency key at all. If a create request actually reached
     * and was processed by the server but the client timed out waiting
     * for the response (a realistic scenario on the flaky rural
     * connections this app's actual users have), the client believed the
     * submit failed, queued a brand-new local-only id for offline retry,
     * and that retry (via engagement.ts's syncOfflineListing) had no way
     * to recognize the already-created row -- producing a genuine
     * duplicate listing.
     *
     * Fixed with the exact atomic-claim ledger pattern
     * activateRocket already uses (see the comment there): `listing`
     * has draftAndPublish:true, which makes storing an operationId
     * directly on the listing row itself unsafe (entityService.create
     * with publishedAt set creates TWO physical rows sharing one
     * documentId -- see findListingByAnyId's own comment), so a separate
     * listing-create-operation ledger content-type claims the
     * operationId FIRST (its unique constraint is what actually
     * serializes concurrent identical requests), and only a request that
     * wins that claim goes on to create the real listing. A retry with
     * the same operationId + same payload returns the already-created
     * listing instead of creating a new one; the same operationId with a
     * DIFFERENT payload is rejected as a conflict.
     */
    async create(ctx) {
      const identity = readIdentity(ctx);
      if (!identity) return ctx.unauthorized('Oturum gerekli.');

      const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
      const input = (body.data ?? body) as Record<string, unknown>;

      const operationId = String(input.operationId ?? '').trim();
      if (!isValidOperationId(operationId)) {
        return ctx.badRequest('operationId zorunlu ve UUID formatinda olmali.');
      }

      const clientPayload = stripIdentifierFields(
        stripClientProtectedFields(input),
      );
      delete (clientPayload as any).operationId;

      // LISTING_L13_MEDIA_LIFECYCLE_REPORT.md L13.3: confirmed live gap
      // -- Strapi's core media-relation connect only checks that a file
      // id EXISTS in plugin::upload.file, never who uploaded/owns it, so
      // nothing previously stopped a user from attaching a file id
      // already visibly in use on someone ELSE's live listing to their
      // own. Rejects only that confirmed case; a freshly-uploaded,
      // not-yet-attached file (the normal case) or the identity's own
      // existing photo remain allowed.
      const requestedPhotoIds = extractRequestedPhotoIds((clientPayload as any).photos);
      for (const fileId of requestedPhotoIds) {
        const owned = await isPhotoOwnedByIdentity(strapi, fileId, identity);
        if (!owned) {
          return ctx.forbidden('Bu fotograf baska bir kullaniciya ait.');
        }
      }
      // L13.17: allowedTypes:["images"] is not enforced by Strapi's own
      // relation-connect for an already-uploaded file id -- see
      // findNonImageFileId's own comment.
      const nonImageId = await findNonImageFileId(strapi, requestedPhotoIds);
      if (nonImageId !== null) {
        return ctx.badRequest('Sadece resim dosyalari fotograf olarak eklenebilir.');
      }

      // LISTING_L20_FINAL_TECHNICAL_INTEGRITY_REPORT.md L20.10: `photos`
      // was previously included in the create fingerprint. Confirmed
      // live: if the FIRST create actually succeeded server-side but the
      // client only saw a lost/timed-out response, the client believes it
      // failed and re-uploads the same photos on retry -- producing BRAND
      // NEW plugin::upload.file ids for logically identical content. That
      // retry (same operationId, different photo ids) then fingerprint-
      // mismatched against the original and was rejected as a CONFLICT
      // (409) instead of being recognized as the same operation --
      // blocking the user's retry entirely AND permanently orphaning the
      // newly re-uploaded (never attached to anything) photo files.
      // Excluding `photos` from the fingerprint fixes this: the same
      // operationId + identical non-photo fields is correctly treated as
      // the same logical submission regardless of which physical upload
      // ids the photos happen to have this attempt, and
      // respondWithLedgeredListing (below) returns the original,
      // already-created listing -- exactly like every other duplicate-
      // operationId retry already does for non-photo fields.
      // A-Z PART 3 P0/P1 CORRECTION FIX B (Madde 45): `createdAtClient` is
      // a client-stamped wall-clock value the Flutter client regenerates
      // fresh on every single publish attempt, including a manual retry
      // of the exact same logical submission -- if it stayed in the
      // fingerprint, a retry that correctly reused the same operationId
      // (per the Flutter-side fix) would still fingerprint-mismatch
      // against the original attempt and be wrongly rejected as a
      // CONFLICT (409) instead of being recognized as the same
      // operation, exactly the failure mode L20.10 already fixed for
      // `photos` above -- same reasoning, same fix shape.
      //
      // `ownerEmail`/`ownerProfileId`/`ownerId` are also excluded: a real
      // retry of the SAME logical submission can land on this direct path
      // OR on engagement.ts's syncOfflineListing (offline-queue replay of
      // the identical operationId) -- that handler always FORCES these
      // three fields from the caller's own identity (never trusts the
      // client's value, a deliberate security property, see its own
      // comment), so the two paths' fingerprints must not depend on
      // whichever raw value happens to be present/absent in each path's
      // payload shape for these three, or a genuinely identical
      // submission retried on the other path would fingerprint-mismatch
      // as a false CONFLICT. `ownerKey: identity.ownerId` below already
      // carries the one identity dimension that actually matters for
      // fingerprinting -- these three are redundant with it.
      const {
        photos: _fingerprintPhotosOmitted,
        createdAtClient: _fingerprintCreatedAtClientOmitted,
        ownerEmail: _fingerprintOwnerEmailOmitted,
        ownerProfileId: _fingerprintOwnerProfileIdOmitted,
        ownerId: _fingerprintOwnerIdOmitted,
        ...fingerprintPayloadFields
      } = clientPayload as Record<string, unknown>;
      const fingerprint = fingerprintPayload({
        ...fingerprintPayloadFields,
        ownerKey: identity.ownerId,
      });

      // Resolves a ledger row (from either the resolveOperation lookup or
      // a lost creation race) to the real, already-created listing and
      // writes the response, OR -- if the ledger row is stale (claimed
      // but never linked to a real listing, e.g. a prior validation
      // failure) -- deletes it and returns false so the caller falls
      // through to a fresh create attempt instead of being stuck forever.
      const respondWithLedgeredListing = async (
        ledgerRow: any,
      ): Promise<boolean> => {
        const documentId = String(ledgerRow?.listingDocumentId ?? '').trim();
        if (!documentId) {
          await strapi.db
            .query(LISTING_CREATE_OPERATION_UID)
            .delete({ where: { id: ledgerRow.id } } as any);
          return false;
        }
        const minimal = await findListingByAnyId(strapi, documentId, ['id']);
        if (!minimal?.id) {
          await strapi.db
            .query(LISTING_CREATE_OPERATION_UID)
            .delete({ where: { id: ledgerRow.id } } as any);
          return false;
        }
        const full = await strapi.entityService.findOne(
          LISTING_UID as any,
          minimal.id as any,
          {},
        );
        if (!full) {
          await strapi.db
            .query(LISTING_CREATE_OPERATION_UID)
            .delete({ where: { id: ledgerRow.id } } as any);
          return false;
        }
        // Deliberately not this.sanitizeOutput/transformResponse here --
        // confirmed live those returned an empty {} body for this action
        // (a POST route's output-sanitization context behaves differently
        // than the GET actions it's normally exercised through elsewhere
        // in this codebase). This response shape matches exactly what
        // super.create's own resolved value looks like (see the
        // createResult capture below).
        ctx.status = 200;
        ctx.body = { data: full, meta: {} };
        return true;
      };

      const resolution = await resolveOperation(
        strapi,
        LISTING_CREATE_OPERATION_UID,
        operationId,
        fingerprint,
      );
      if (resolution.status === 'conflict') {
        return ctx.conflict(
          'Bu islem kimligi farkli bir ilan gonderimi icin kullanilmis.',
        );
      }
      if (resolution.status === 'duplicate') {
        const responded = await respondWithLedgeredListing(
          resolution.existing,
        );
        if (responded) return;
        // Stale claim -- respondWithLedgeredListing already deleted it;
        // fall through to a fresh attempt below.
      }

      const profile = await findProfileForIdentity(
        strapi,
        identity.email,
        identity.ownerId,
      );

      const ownerProfileId =
        clean(profile?.profileId) ||
        identity.ownerId ||
        ownerIdFromEmail(identity.email);
      const isPremium = hasActivePremiumExpiry(profile);
      const publishedAt = new Date().toISOString();

      if (!isPremium) {
        const canCreate = await canCreateNextNormalListing(
          strapi,
          ownerProfileId,
        );
        if (!canCreate) {
          return ctx.forbidden(
            `Normal hesapta ilk ${NORMAL_LISTING_FREE_COUNT} ilan ucretsizdir. Yeni ilan acmak icin ${NORMAL_LISTING_BLOCK_SIZE} ilan hakki paketi satin almalisin.`,
          );
        }
      }

      // The ledger create is the atomic claim: operationId's unique
      // constraint means only one concurrent request with the same
      // operationId can ever win this insert -- the loser re-reads the
      // winner's result instead of separately creating a listing.
      let raced = false;
      try {
        await strapi.entityService.create(LISTING_CREATE_OPERATION_UID as any, {
          data: {
            operationId,
            payloadFingerprint: fingerprint,
            ownerProfileId,
          },
        });
      } catch (_e) {
        raced = true;
      }
      if (raced) {
        const existing = await strapi.db
          .query(LISTING_CREATE_OPERATION_UID)
          .findOne({ where: { operationId } } as any);
        if (existing) {
          const responded = await respondWithLedgeredListing(existing);
          if (responded) return;
        }
        return ctx.internalServerError('Ilan gonderim kaydi dogrulanamadi.');
      }

      ctx.query = {
        ...(ctx.query ?? {}),
        status: 'published',
      };

      // LISTING_L3_LISTING_TYPE_AND_PUBLIC_NUMBER_REPORT.md L3.5/L3.7: the
      // public listing number is server-generated here -- any
      // client-supplied listingNo in clientPayload was already stripped by
      // stripClientProtectedFields above, and this assignment overwrites
      // whatever remained regardless.
      //
      // Both physical rows this one super.create call produces
      // (draftAndPublish:true means a draft, publishedAt:null, and the
      // published row) get the SAME listingNo, same as every other field
      // -- confirmed necessary live while writing this fix: a plain PUT
      // update (the normal edit path) re-syncs the published row's
      // content from the draft, so a listingNo that only ever existed on
      // the published side gets silently wiped back to null by the very
      // next unrelated edit. Concurrency safety therefore can't be a
      // plain single-column unique index (that would reject a row's own
      // draft/published pair for sharing the same number) -- it's a
      // PARTIAL unique index scoped to `WHERE published_at IS NOT NULL`
      // (ensureListingNoUniqueIndex, src/index.ts), so only published
      // rows compete for uniqueness and a row's own draft sibling never
      // conflicts with it. A genuine collision between two DIFFERENT
      // published rows still throws from super.create, and this loop
      // recomputes MAX+1 and retries -- the identical catch-and-retry
      // shape the ledger claim above already uses for its own race.
      const MAX_LISTING_NO_ATTEMPTS = 5;
      let createResult: any;
      let lastCreateError: unknown = null;
      const searchFields = computeListingSearchFields({
        title: clientPayload.title,
        description: clientPayload.description,
        mainType: clientPayload.mainType,
        subType: clientPayload.subType,
        location: clientPayload.location,
        ownerCity: clientPayload.ownerCity,
      });
      for (let attempt = 0; attempt < MAX_LISTING_NO_ATTEMPTS; attempt++) {
        const listingNo = await nextListingNo(strapi);
        ctx.request.body = {
          data: {
            ...clientPayload,
            ownerProfileId,
            ownerId: ownerProfileId,
            ownerEmail: normalizeEmail(identity.email),
            isPremium,
            isPremiumOwner: isPremium,
            status: 'active',
            publishedAt,
            listingNo,
            ...searchFields,
          },
        };
        try {
          // super.create(ctx) resolves to the response body itself (it
          // does NOT set ctx.body as a side effect -- confirmed live
          // while writing this fix: awaiting it without using its return
          // value left ctx.body undefined and Koa fell back to a plain
          // "Created" text response). Must both capture and return this
          // so Strapi's own dispatcher still sends the real JSON
          // response.
          createResult = await super.create(ctx);
          lastCreateError = null;
          break;
        } catch (e) {
          lastCreateError = e;
        }
      }
      if (lastCreateError) throw lastCreateError;

      // Link the ledger claim to the real created row so a later retry
      // (a genuine duplicate hit) can resolve to it. A genuine super.create
      // failure (validation error etc.) throws before reaching here, so
      // the claim is deliberately left unlinked in that case -- the next
      // retry with the same operationId will find it stale (no linked
      // listing) and self-heal by deleting it and trying again, rather
      // than being permanently stuck.
      try {
        const createdData = (createResult as any)?.data;
        const createdDocumentId = createdData?.documentId ?? createdData?.id;
        if (createdDocumentId) {
          await strapi.db.query(LISTING_CREATE_OPERATION_UID).update({
            where: { operationId },
            data: { listingDocumentId: String(createdDocumentId) },
          } as any);
        }
      } catch (e) {
        strapi.log.warn(
          `Listing create operation ledger link failed: ${String(e)}`,
        );
      }

      return createResult;
    },

    async update(ctx) {
      const identity = readIdentity(ctx);
      if (!identity) return ctx.unauthorized('Oturum gerekli.');

      const body = (ctx.request?.body ?? {}) as Record<string, any>;
      const input = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, any>;

      // LISTING_SYSTEM_RELEASE_FORENSIC_AUDIT.md BUG-LISTING-005: unlike
      // create(), update() never re-forced ownerEmail/ownerProfileId/
      // ownerId from the caller's identity -- listing-owner-write policy
      // (which runs first) only verifies the CURRENT row's owner fields
      // match the caller, it never strips or overwrites the update body.
      // A real owner could therefore include a different ownerEmail/
      // ownerProfileId/ownerId in their own PUT body and reassign their
      // own listing's ownership to an arbitrary identity. Forcing these
      // from `identity` here is safe: the policy has already proven
      // `identity` is the row's rightful owner by the time this runs.
      const cleanInput = stripIdentifierFields(stripClientProtectedFields(input));

      // LISTING_L6_SERVER_SEARCH_FILTER_SORT_REPORT.md L6.4/L6.7: a normal
      // edit (e.g. title-only) must not blank city/searchNormalized for
      // fields it never touched -- read the current row first and
      // recompute from the MERGED state (existing values overridden by
      // whatever this edit actually changes), the same "real value wins"
      // rule L1 established for category-field edit hydration.
      const existing = await findListingByAnyId(strapi, ctx.params?.id, [
        'id',
        'documentId',
        'title',
        'description',
        'mainType',
        'subType',
        'location',
        'ownerCity',
      ]);
      const searchFields = computeListingSearchFields({
        title: cleanInput.title ?? existing?.title,
        description: cleanInput.description ?? existing?.description,
        mainType: cleanInput.mainType ?? existing?.mainType,
        subType: cleanInput.subType ?? existing?.subType,
        location: cleanInput.location ?? existing?.location,
        ownerCity: cleanInput.ownerCity ?? existing?.ownerCity,
      });

      // LISTING_L13_MEDIA_LIFECYCLE_REPORT.md L13.3/L13.7/L13.8/L13.9: a
      // client PUT can change the `photos` relation to add/remove/
      // replace listing photos -- reads the CURRENT relation first
      // (before the write) so (a) any newly-referenced file id can be
      // ownership-checked (an id already on this listing obviously
      // already belongs to it, only genuinely NEW ids need checking),
      // and (b) any id present before but absent after this update can
      // be considered for orphan cleanup once the write itself commits
      // successfully -- never before, so a failed update never deletes
      // photos that are still very much in use (L13.9's explicit
      // ordering requirement).
      const documentId = String((existing as any)?.documentId ?? '').trim();
      const photosProvided = Object.prototype.hasOwnProperty.call(cleanInput, 'photos');
      let previousPhotoIds: number[] = [];
      if (photosProvided && (existing as any)?.id) {
        const withPhotos = await strapi.entityService.findOne(LISTING_UID as any, (existing as any).id, {
          populate: ['photos'],
        } as any);
        previousPhotoIds = extractRequestedPhotoIds((withPhotos as any)?.photos);
      }
      if (photosProvided) {
        const requestedPhotoIds = extractRequestedPhotoIds((cleanInput as any).photos);
        const newlyReferencedIds = requestedPhotoIds.filter(
          (id) => !previousPhotoIds.includes(id),
        );
        for (const fileId of newlyReferencedIds) {
          const owned = await isPhotoOwnedByIdentity(strapi, fileId, identity);
          if (!owned) {
            return ctx.forbidden('Bu fotograf baska bir kullaniciya ait.');
          }
        }
        // L13.17: same allowedTypes gap as create() -- only newly
        // referenced ids need checking, since an id already on this
        // listing was already validated when it was first attached.
        const nonImageId = await findNonImageFileId(strapi, newlyReferencedIds);
        if (nonImageId !== null) {
          return ctx.badRequest('Sadece resim dosyalari fotograf olarak eklenebilir.');
        }
      }

      ctx.request.body = {
        data: {
          ...cleanInput,
          ownerProfileId: identity.ownerId,
          ownerId: identity.ownerId,
          ownerEmail: normalizeEmail(identity.email),
          ...searchFields,
        },
      };
      const result = await super.update(ctx);

      if (photosProvided && documentId) {
        const requestedPhotoIds = extractRequestedPhotoIds((cleanInput as any).photos);
        const removedIds = previousPhotoIds.filter(
          (id) => !requestedPhotoIds.includes(id),
        );
        if (removedIds.length > 0) {
          // Awaited (not fire-and-forget) so cleanup can't be cut short
          // by the request/response cycle ending -- safe either way,
          // since cleanupOrphanedPhotoIds already catches and logs its
          // own per-file failures and never throws (L13.23), so this
          // can never turn into an update failure for the caller.
          await cleanupOrphanedPhotoIds(strapi, removedIds, documentId);
        }
      }

      return result;
    },

    /**
     * LISTING_L13_MEDIA_LIFECYCLE_REPORT.md L13.9: the stock core delete
     * action (previously unoverridden -- confirmed via forensic) removes
     * only the listing's own DB row(s) (both draft+published, since
     * draftAndPublish:true) and leaves every attached upload-plugin file
     * completely untouched -- 100% of a deleted listing's photos became
     * permanent orphans before this fix. Captures the listing's own
     * photos BEFORE deleting (never after -- there would be nothing left
     * to read), lets the real delete proceed, and only THEN considers
     * each photo for cleanup, still gated by the same "not referenced
     * elsewhere" check every removal path uses (L13.10) -- a photo this
     * listing shared with, say, a re-used upload on another of the
     * owner's own listings is never touched. If delete itself fails,
     * nothing is cleaned up (the early return below).
     */
    async delete(ctx) {
      const existing = await findListingByAnyId(strapi, ctx.params?.id, [
        'id',
        'documentId',
      ]);
      const documentId = String((existing as any)?.documentId ?? '').trim();
      let photoIds: number[] = [];
      if (existing?.id) {
        const withPhotos = await strapi.entityService.findOne(LISTING_UID as any, (existing as any).id, {
          populate: ['photos'],
        } as any);
        photoIds = extractRequestedPhotoIds((withPhotos as any)?.photos);
      }

      const result = await super.delete(ctx);

      if (documentId && photoIds.length > 0) {
        await cleanupOrphanedPhotoIds(strapi, photoIds, documentId);
      }

      return result;
    },

    /**
     * PREMIUM_P1_TARGETED_FIX_REPORT.md, BUG-PREM-001: the only prior
     * write path for a listing's isDoping/rocketEndsAt was a plain PUT
     * /listings/:id -- which stripClientProtectedFields now (correctly)
     * blocks, per BUG-LISTING-004. That closed a self-grant exploit but
     * also broke the ONE legitimate activation flow (premium rocket
     * credit or a paid doping_* purchase), since no replacement
     * server-authoritative path existed. This action is that
     * replacement: it never trusts a client-supplied isDoping/
     * rocketEndsAt (the client sends only `days` + an idempotency
     * `operationId`), verifies a real entitlement against the EXISTING
     * sources of truth (profile-setting.activePremium.rocketRemaining,
     * or an unconsumed verified purchase-event for the matching
     * doping_* SKU -- no third parallel entitlement system), and is
     * idempotent against retries/double-taps via the same
     * operationId+fingerprint ledger pattern listing-comment/
     * listing-share already use.
     */
    async activateRocket(ctx) {
      const identity = readIdentity(ctx);
      if (!identity) return ctx.unauthorized('Oturum gerekli.');

      const rawId = String(ctx.params?.id ?? '').trim();
      if (!rawId) return ctx.badRequest('Ilan kimligi zorunlu.');

      const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
      const data = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, unknown>;
      const days = Number(data.days);
      const operationId = String(data.operationId ?? '').trim();
      if (!ROCKET_VALID_DAYS.has(days)) {
        return ctx.badRequest('Gecersiz roket suresi.');
      }
      if (!isValidOperationId(operationId)) {
        return ctx.badRequest('operationId gecersiz.');
      }

      const listing = await findListingByAnyId(strapi, rawId, [
        'id',
        'documentId',
        'listingNo',
        'ownerEmail',
        'ownerProfileId',
        'ownerId',
        'rocketEndsAt',
      ]);
      if (!listing) return ctx.notFound('Ilan bulunamadi.');
      if (
        !matchesIdentity(
          listing as Record<string, unknown>,
          identity,
          ['ownerEmail'],
          ['ownerProfileId', 'ownerId'],
        )
      ) {
        return ctx.forbidden('Bu ilan size ait degil.');
      }

      // documentId, not the numeric id, is what identifies "the same
      // listing" stably across requests for fingerprinting purposes --
      // see findListingByAnyId's own PUBLISHED_ONLY comment for why the
      // numeric id alone is not a safe cross-request identity here.
      const fingerprint = fingerprintPayload({
        listingId: (listing as any).documentId,
        days,
      });
      const resolution = await resolveOperation(
        strapi,
        ROCKET_ACTIVATION_UID,
        operationId,
        fingerprint,
      );
      if (resolution.status === 'conflict') {
        return ctx.conflict('Bu islem kimligi baska bir roketleme icin kullanilmis.');
      }
      if (resolution.status === 'duplicate') {
        const existing = resolution.existing;
        ctx.body = {
          data: {
            ok: true,
            isDoping: true,
            rocketEndsAt: existing.rocketEndsAt,
            idempotent: true,
          },
        };
        return;
      }

      const profile = await loadPremiumProfile(strapi, identity);
      const premium = (profile?.activePremium ?? profile?.activePremiumSubscription ?? null) as
        | Record<string, unknown>
        | null;
      const rocketRemaining = Number(premium?.rocketRemaining ?? 0);
      const rocketDays = Number(premium?.rocketDays ?? 0);
      const premiumEligible =
        isPremiumActiveFromProfile(profile) && rocketRemaining > 0 && rocketDays === days;

      let purchaseEvent: Record<string, unknown> | null = null;
      if (!premiumEligible) {
        const productId = ROCKET_PRODUCT_BY_DAYS[days];
        const candidate = productId
          ? ((await strapi.db.query(PURCHASE_EVENT_UID).findOne({
              where: {
                ownerProfileId: identity.ownerId,
                productId,
                status: 'verified',
              },
              orderBy: { verifiedAt: 'desc' },
            } as any)) as Record<string, unknown> | null)
          : null;
        if (candidate) {
          const consumed = await strapi.db.query(ROCKET_ACTIVATION_UID).findOne({
            where: { purchaseTransactionId: candidate.transactionId },
          } as any);
          if (!consumed) purchaseEvent = candidate;
        }
      }

      if (!premiumEligible && !purchaseEvent) {
        return ctx.forbidden(
          'Aktif roket hakkiniz veya odemesi dogrulanmis bir roket satin aliminiz yok.',
        );
      }

      const sourceType: 'premium_credit' | 'purchase' = premiumEligible
        ? 'premium_credit'
        : 'purchase';
      // Extend from the listing's current rocketEndsAt if it's still in
      // the future (matches ListingsStore.setRocket's existing Flutter-
      // side extension semantics), otherwise start counting from now.
      const currentRocketEndsAt = new Date(String((listing as any).rocketEndsAt ?? ''));
      const extendFrom =
        !Number.isNaN(currentRocketEndsAt.getTime()) && currentRocketEndsAt.getTime() > Date.now()
          ? currentRocketEndsAt
          : new Date();
      const rocketEndsAt = new Date(
        extendFrom.getTime() + days * 24 * 60 * 60 * 1000,
      ).toISOString();

      // The ledger create is the atomic claim: operationId's unique
      // constraint means only one concurrent request with the same
      // operationId can ever win this insert -- the loser re-reads the
      // winner's result instead of separately consuming the entitlement.
      let raced = false;
      try {
        await strapi.entityService.create(ROCKET_ACTIVATION_UID as any, {
          data: {
            operationId,
            payloadFingerprint: fingerprint,
            listingId: String((listing as any).documentId),
            ownerProfileId: identity.ownerId,
            sourceType,
            purchaseTransactionId:
              sourceType === 'purchase' ? String(purchaseEvent!.transactionId) : null,
            days,
            rocketEndsAt,
          },
        });
      } catch (_e) {
        raced = true;
      }
      if (raced) {
        const existing = await strapi.db.query(ROCKET_ACTIVATION_UID).findOne({
          where: { operationId },
        } as any);
        if (existing) {
          ctx.body = {
            data: {
              ok: true,
              isDoping: true,
              rocketEndsAt: existing.rocketEndsAt,
              idempotent: true,
            },
          };
          return;
        }
        return ctx.internalServerError('Roketleme kaydi dogrulanamadi.');
      }

      if (sourceType === 'premium_credit' && profile?.id) {
        const nextPremium = {
          ...(premium as Record<string, unknown>),
          rocketRemaining: rocketRemaining - 1,
        };
        await strapi.entityService.update(PROFILE_UID as any, profile.id as any, {
          data: {
            activePremium: nextPremium,
            activePremiumSubscription: nextPremium,
          },
        });
      }

      // This content-type has draftAndPublish:true, meaning a single
      // documentId can back TWO physical rows (a draft and a published
      // one) -- confirmed live while writing this fix that targeting only
      // the one row findListingByAnyId happened to resolve (whether via
      // entityService.update or a single-row db.query update) could leave
      // a sibling row unchanged, and which row a subsequent reader
      // resolves back to is not reliably the one just written. Updating
      // every row for this documentId sidesteps the ambiguity entirely:
      // whichever row any reader (REST API, another db.query call)
      // resolves to next, it already has the correct isDoping/rocketEndsAt.
      await strapi.db.query(LISTING_UID).updateMany({
        where: { documentId: (listing as any).documentId },
        data: { isDoping: true, rocketEndsAt },
      } as any);

      ctx.body = {
        data: {
          ok: true,
          isDoping: true,
          rocketEndsAt,
          rocketRemaining: sourceType === 'premium_credit' ? rocketRemaining - 1 : null,
        },
      };
    },

    /**
     * LISTING_L19_MARKETPLACE_PRODUCT_GAP_FOUNDATIONS_REPORT.md
     * L19.9-L19.17: `GET /listings/:id/similar` -- a deterministic,
     * bounded-candidate similarity feed (see listing-similar-query.ts's
     * own header for the full scoring/mode-semantics rationale). Public
     * route, but applies the exact same visibility rule as `findOne()`
     * above: a pending/rejected reference listing's similar-set is not
     * computable by anyone except its own owner, so this can never be
     * used to probe whether a hidden listing exists.
     */
    async similar(ctx) {
      const rawId = String(ctx.params?.id ?? '').trim();
      const row = await findListingByAnyId(strapi, rawId, [
        'id',
        'documentId',
        'status',
        'ownerEmail',
        'ownerProfileId',
        'ownerId',
        'listingNo',
        'mainType',
        'subType',
        'cityNormalized',
        'price',
        'mode',
      ]);
      if (!row) return ctx.notFound('Ilan bulunamadi.');

      const identity = readIdentity(ctx);
      const isOwner =
        !!identity &&
        matchesIdentity(
          row as Record<string, unknown>,
          identity,
          ['ownerEmail'],
          ['ownerProfileId', 'ownerId'],
        );
      const status = String((row as any).status ?? '').trim().toLowerCase();
      if (!isOwner && status !== 'active') {
        return ctx.notFound('Ilan bulunamadi.');
      }

      const page = Number(ctx.query?.page) || 1;
      const pageSizeRaw = Number(ctx.query?.pageSize);
      const pageSize = Number.isFinite(pageSizeRaw) && pageSizeRaw > 0 ? pageSizeRaw : undefined;

      const { results, pagination } = await fetchSimilarListingsPage(
        strapi,
        {
          listingNo: (row as any).listingNo ?? null,
          mainType: (row as any).mainType ?? null,
          subType: (row as any).subType ?? null,
          cityNormalized: (row as any).cityNormalized ?? null,
          price: (row as any).price ?? null,
          mode: (row as any).mode ?? null,
        },
        page,
        pageSize as any,
      );
      ctx.body = { data: results, meta: { pagination } };
    },
  }),
);
