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
      }
      return super.find(ctx);
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
      const fingerprint = fingerprintPayload({
        ...clientPayload,
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

      ctx.request.body = {
        data: {
          ...cleanInput,
          ownerProfileId: identity.ownerId,
          ownerId: identity.ownerId,
          ownerEmail: normalizeEmail(identity.email),
          ...searchFields,
        },
      };
      return super.update(ctx);
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
  }),
);
