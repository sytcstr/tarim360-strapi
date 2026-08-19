/**
 * listing controller
 */

import { factories } from '@strapi/strapi';
import { matchesIdentity, normalizeEmail, ownerIdFromEmail, readIdentity } from '../../../utils/identity';
import { isPremiumActiveFromProfile, loadPremiumProfile } from '../../../utils/premium-sync';
import { findListingByAnyId, stripListingProtectedFields } from '../../../utils/listing-metrics';
import { fingerprintPayload, isValidOperationId, resolveOperation } from '../../../utils/operation-idempotency';

const LISTING_UID = 'api::listing.listing';
const PROFILE_UID = 'api::profile-setting.profile-setting';
const PURCHASE_EVENT_UID = 'api::purchase-event.purchase-event';
const ROCKET_ACTIVATION_UID = 'api::rocket-activation.rocket-activation';

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
    async create(ctx) {
      const identity = readIdentity(ctx);
      if (!identity) return ctx.unauthorized('Oturum gerekli.');

      const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
      const input = (body.data ?? body) as Record<string, unknown>;
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

      ctx.request.body = {
        data: {
          ...stripIdentifierFields(stripClientProtectedFields(input)),
          ownerProfileId,
          ownerId: ownerProfileId,
          ownerEmail: normalizeEmail(identity.email),
          isPremium,
          isPremiumOwner: isPremium,
          status: 'active',
          publishedAt,
        },
      };
      ctx.query = {
        ...(ctx.query ?? {}),
        status: 'published',
      };

      return super.create(ctx);
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
      ctx.request.body = {
        data: {
          ...stripIdentifierFields(stripClientProtectedFields(input)),
          ownerProfileId: identity.ownerId,
          ownerId: identity.ownerId,
          ownerEmail: normalizeEmail(identity.email),
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
