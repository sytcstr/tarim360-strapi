/**
 * profile-setting controller
 */

import { factories } from '@strapi/strapi';
import { readIdentity, resolveActorProfile } from '../../../utils/identity';
import { fingerprintPayload, isValidOperationId } from '../../../utils/operation-idempotency';

const UID = 'api::profile-setting.profile-setting';

/**
 * ENGAGEMENT_E2_TARGETED_FIX_REPORT.md BUG-ENG-007: viewCount/
 * engagementVersion must never be settable through the generic create/
 * update actions -- the canonical `POST /engagements/view` flow
 * (engagement-view-service.ts, via db.query/db.transaction directly,
 * never through this controller) is the only real source of truth for
 * these fields. Without this guard a user could PUT their own
 * profile-setting row with an arbitrary viewCount to self-inflate a
 * publicly-displayed number. Mirrors the same pattern already used by
 * listing/logistics/processed-product controllers.
 */
const ENGAGEMENT_ONLY_FIELDS = ['viewCount', 'engagementVersion'];

/**
 * FINAL_R1_TARGETED_RELEASE_FIX_REPORT.md R1.1 (FINAL-BUG-001, CRITICAL):
 * these fields are the sole source every premium/rocket/AI gate in the
 * app reads (isPremiumActiveFromProfile, listing.ts activateRocket,
 * ai.ts ensureAiAccess, processed-products.ts requireActivePremium) --
 * but until this fix, this generic controller only stripped the two
 * ENGAGEMENT_ONLY_FIELDS above, leaving these completely unprotected.
 * Any authenticated user could PUT their own profile-setting row with
 * a forged activePremium/activePremiumSubscription and self-grant real
 * paid entitlements with zero purchase. The one legitimate writer of
 * these fields, src/api/purchase/lib/persistence.ts, writes via
 * strapi.entityService.update/create directly (never through this HTTP
 * controller), so stripping them here cannot break real premium sync.
 */
const PURCHASE_PROTECTED_FIELDS = [
  'activePremium',
  'activePremiumSubscription',
  'purchaseHistory',
  'purchaseRecords',
  'purchaseUpdatedAt',
];

/**
 * Soru/Profil/Kart denetimi (2026-10-25) Profil grubu Madde 17: none of
 * these were ever stripped, unlike the two field families above --
 * BACKEND_FLUTTER_SEMANTIC_CONTRACT_AUDIT.md already flagged this in
 * theory ("no sanitization exists for ratingBaseCount/ratingBaseAverage")
 * and it was confirmed empirically this round (a real PUT with a forged
 * ratingBaseAverage/ratingBaseCount/followersFallback persisted as-is and
 * reflected straight through to GET /public-profiles/:ownerId for any
 * real visitor). Now that rating/follow/comment writes go through their
 * own dedicated, server-controlled actions below (rateProfile,
 * followProfile/unfollowProfile, addProfileComment -- never this generic
 * create/update), nothing legitimate ever needs to set these fields
 * through this controller again, so stripping them here cannot break any
 * real sync path (mirrors the exact reasoning already established for
 * PURCHASE_PROTECTED_FIELDS above). Every schema alias of each concept is
 * included, not just the primary name, since `_loadFromStrapi`/
 * `_loadUserFromStrapi` (Flutter) and `computeRating` (public-profile.ts)
 * both fall back to the alias if the primary is absent.
 */
const RATING_FOLLOW_AGGREGATE_FIELDS = [
  'ratingVotesByViewer',
  'ratingVotes',
  'ratingBaseCount',
  'voteCountBase',
  'ratingBaseAverage',
  'ratingAverageBase',
  'followerIds',
  'followersIds',
  'followers',
  'followingIds',
  'followsIds',
  'following',
  'followersFallback',
  'followingFallback',
  'followersCountBase',
  'followingCountBase',
  'incomingProfileComments',
  'incomingComments',
];

const CLIENT_STRIPPED_FIELDS = [
  ...ENGAGEMENT_ONLY_FIELDS,
  ...PURCHASE_PROTECTED_FIELDS,
  ...RATING_FOLLOW_AGGREGATE_FIELDS,
];

const stripEngagementFields = (data: Record<string, any>): Record<string, any> => {
  const next = { ...data };
  for (const field of CLIENT_STRIPPED_FIELDS) delete next[field];
  return next;
};

/** Soru/Profil/Kart denetimi Madde 13: same fallback name
 * farmer-question-privacy.ts's FARMER_IDENTITY_FALLBACK_NAME uses, for
 * the identical reason -- a commenter's email-derived name must never
 * leak a real email fragment as the "public" display name when they
 * have no profile-setting row yet. */
const PROFILE_IDENTITY_FALLBACK_NAME = 'Kullanıcı';

const toStringArray = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    const s = String(v ?? '').trim();
    if (s) out.push(s);
  }
  return out;
};

const toRecord = (raw: unknown): Record<string, unknown> =>
  raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

const toArray = (raw: unknown): unknown[] => (Array.isArray(raw) ? raw : []);

/**
 * Soru/Profil/Kart denetimi Madde 14/18 (eşzamanlılık garantisi): a
 * shared read-modify-write for exactly ONE profile-setting row's JSON
 * fields. The REAL lost-update guard is the `SELECT ... FOR UPDATE`
 * row lock acquired below via raw Knex (`trx(...).forUpdate()`) --
 * on this project's production dialect (Postgres) this genuinely BLOCKS
 * a second concurrent transaction that also targets this exact row until
 * the first one commits, so its own subsequent read always sees the
 * first transaction's write, never a stale pre-write snapshot. That is
 * the actual atomicity guarantee this function provides; it is not an
 * in-memory lock and does not depend on any single process.
 *
 * On SQLite (local dev/the integration tests in this repo) `.forUpdate()`
 * is a documented Knex no-op -- engagement-view-service.ts's own
 * `registerView` already found and commented on this exact limitation.
 * This round's own concurrency tests (6 simultaneous voters/followers/
 * commenters on one row, all preserved) pass on SQLite, but that is
 * SQLite's OWN single-writer-per-file behavior happening to serialize
 * the transactions anyway -- it is NOT evidence that the lock itself is
 * doing anything on that dialect, and must never be read as a
 * production (Postgres) guarantee. The `.forUpdate()` call is what
 * actually matters there.
 *
 * The lock is acquired via a raw Knex query (Strapi's own
 * db.query()/entityService calls have no `.forUpdate()` equivalent) but
 * the row is still READ and WRITTEN through Strapi's normal
 * db.query()/entityService.update() -- VERIFIED (not just assumed) that
 * both run on the SAME transaction/connection as the raw lock query:
 * `strapi.db.transaction()` runs its callback inside an AsyncLocalStorage
 * context (@strapi/database's transaction-context.js), and every
 * db.query() call (which entityService.update/findOne delegate to
 * internally) reads that SAME ambient context and binds its Knex query to
 * it via `.transacting(trx)` automatically (query-builder.js's own
 * `execute()`) -- confirmed by reading that source directly, not inferred
 * from this project's own prior precedent alone. So JSON (de)serialization
 * stays Strapi's own dialect-safe code path; only the LOCK acquisition
 * itself is a raw query.
 */
async function withProfileRow<T>(
  strapi: any,
  documentId: string,
  mutate: (row: Record<string, any>) => { data: Record<string, any>; result: T },
): Promise<T | null> {
  return strapi.db.transaction(async ({ trx }: { trx: any }) => {
    const locked = await trx('profile_settings').where('document_id', documentId).forUpdate().first('id');
    if (!locked) return null;
    const row = await strapi.db.query(UID).findOne({ where: { documentId } });
    if (!row) return null;
    const { data, result } = mutate(row);
    await strapi.entityService.update(UID as any, row.id, { data });
    return result;
  });
}

/**
 * Soru/Profil/Kart denetimi Madde 14 (kilidin kapsamı): follow/unfollow
 * touches TWO rows (the target's followerIds AND the caller's own
 * followingIds) -- both must be locked, inside the SAME transaction, in
 * a FIXED, deterministic order regardless of which one is logically the
 * "target" vs the "viewer" for THIS call. Without this, a genuine
 * A-follows-B running concurrently with B-follows-A could lock the two
 * rows in OPPOSITE order (A's transaction: target B then viewer A; B's
 * transaction: target A then viewer B) -- on a real row-locking dialect
 * (Postgres) that is the textbook two-transaction deadlock shape.
 * Sorting the two documentIds lexicographically before locking guarantees
 * every concurrent caller requests the SAME row first, so the second
 * transaction simply WAITS for the first instead of deadlocking. Returns
 * false (no-op) if either row cannot be found.
 */
async function withTwoProfileRows(
  strapi: any,
  documentIdA: string,
  documentIdB: string,
  mutate: (
    rowA: Record<string, any>,
    rowB: Record<string, any>,
  ) => { dataA: Record<string, any>; dataB: Record<string, any> },
): Promise<boolean> {
  const [firstId, secondId] = [documentIdA, documentIdB].sort();
  return strapi.db.transaction(async ({ trx }: { trx: any }) => {
    const firstLocked = await trx('profile_settings').where('document_id', firstId).forUpdate().first('id');
    if (!firstLocked) return false;
    // documentIdA === documentIdB would double-lock the same row within
    // one transaction (never happens here -- a caller can never follow
    // itself, checked before this is ever called -- but guarded anyway).
    const secondLocked =
      secondId === firstId
        ? firstLocked
        : await trx('profile_settings').where('document_id', secondId).forUpdate().first('id');
    if (!secondLocked) return false;

    const rowA = await strapi.db.query(UID).findOne({ where: { documentId: documentIdA } });
    const rowB = await strapi.db.query(UID).findOne({ where: { documentId: documentIdB } });
    if (!rowA || !rowB) return false;

    const { dataA, dataB } = mutate(rowA, rowB);
    await strapi.entityService.update(UID as any, rowA.id, { data: dataA });
    await strapi.entityService.update(UID as any, rowB.id, { data: dataB });
    return true;
  });
}

export default factories.createCoreController(UID as any, ({ strapi }) => ({
  async create(ctx: any) {
    const body = (ctx.request?.body ?? {}) as Record<string, any>;
    const input = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, any>;
    ctx.request.body = { data: stripEngagementFields(input) };
    return super.create(ctx);
  },

  async update(ctx: any) {
    const body = (ctx.request?.body ?? {}) as Record<string, any>;
    const input = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, any>;
    ctx.request.body = { data: stripEngagementFields(input) };
    return super.update(ctx);
  },

  /**
   * Soru/Profil/Kart denetimi Madde 13 (rapor -> düzeltme): the ONLY real
   * write path for rating someone ELSE's profile. Replaces
   * ProfileRatingStore._syncToStrapi's old client-driven
   * upsertProfileSettings(profileId: <target>, ...) call, which the
   * generic controller's own "pid != sessionOwner" guard silently
   * dropped for every real cross-profile rating -- the rating never
   * reached the server at all. Here the CALLER's identity is the voter
   * (server-derived, never client-claimed) and the TARGET is whichever
   * profile's own document gets updated -- the server does the
   * cross-profile write, which a client is never allowed to do directly,
   * exactly like addFarmerQuestionAnswer writes to a question it does
   * not own.
   *
   * Idempotent by construction: re-submitting the same (voter, stars)
   * just overwrites the SAME map entry -- no operationId needed, a
   * retry/double-tap can never create a second vote or inflate the
   * count.
   */
  async rateProfile(ctx: any) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

    const targetProfileId = String(ctx.params?.profileId ?? '').trim();
    if (!targetProfileId) return ctx.badRequest('profileId zorunlu.');
    if (targetProfileId === identity.ownerId) {
      return ctx.badRequest('Kendi profilinize puan veremezsiniz.');
    }

    const body = (ctx.request?.body ?? {}) as Record<string, any>;
    const input = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, any>;
    const stars = Math.round(Number(input.stars));
    if (!Number.isFinite(stars) || stars < 1 || stars > 5) {
      return ctx.badRequest('stars 1-5 arasinda bir tam sayi olmali.');
    }

    const targetRow = await strapi.db.query(UID).findOne({ where: { profileId: targetProfileId } });
    if (!targetRow) return ctx.notFound('Hedef profil bulunamadi.');

    const result = await withProfileRow(strapi, targetRow.documentId, (row) => {
      const votes = toRecord(row.ratingVotesByViewer ?? row.ratingVotes);
      const nextVotes = { ...votes, [identity.ownerId]: stars };
      return {
        data: {
          ratingVotesByViewer: nextVotes,
          ratingVotes: nextVotes,
          ratingUpdatedAt: new Date().toISOString(),
        },
        result: nextVotes,
      };
    });
    if (!result) return ctx.notFound('Hedef profil bulunamadi.');

    ctx.body = { data: { ok: true } };
  },

  /**
   * Soru/Profil/Kart denetimi Madde 13 (rapor -> düzeltme): the ONLY real
   * write path for leaving a comment on someone ELSE's profile. Replaces
   * ProfileCommentsStore.addIncomingProfileComment's old client-driven
   * upsertProfileSettings(profileId: <target>, ...) call -- same silent
   * drop as rating, same fix shape. The commenter's real name/city/
   * avatar are resolved server-side from their OWN profile-setting row
   * (resolveActorProfile, the exact helper farmer-question answers
   * already use for the same reason) -- a client-supplied fromName is
   * never trusted, mirroring the farmer-question answer-identity fix.
   *
   * Idempotency: a client-generated operationId (UUID) -- same
   * operation-idempotency.ts contract addFarmerQuestionAnswer already
   * uses -- because unlike a vote, each comment is a genuinely new list
   * entry; without this a double-tap/retry would append a second,
   * duplicate comment.
   */
  async addProfileComment(ctx: any) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

    const targetProfileId = String(ctx.params?.profileId ?? '').trim();
    if (!targetProfileId) return ctx.badRequest('profileId zorunlu.');
    if (targetProfileId === identity.ownerId) {
      return ctx.badRequest('Kendi profilinize yorum yazamazsınız.');
    }

    const body = (ctx.request?.body ?? {}) as Record<string, any>;
    const input = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, any>;
    const text = String(input.text ?? '').trim();
    if (!text) return ctx.badRequest('Yorum metni bos olamaz.');
    const operationId = String(input.operationId ?? '').trim();
    if (!isValidOperationId(operationId)) {
      return ctx.badRequest('Gecerli bir operationId gerekli.');
    }
    const ratingStars = Math.round(Number(input.rating));
    const rating = Number.isFinite(ratingStars) && ratingStars >= 1 && ratingStars <= 5 ? ratingStars : 0;

    const targetRow = await strapi.db.query(UID).findOne({ where: { profileId: targetProfileId } });
    if (!targetRow) return ctx.notFound('Hedef profil bulunamadi.');

    const fingerprint = fingerprintPayload({ actor: identity.ownerId, target: targetProfileId, text });

    const profile = await resolveActorProfile(strapi, identity.ownerId, {
      name: PROFILE_IDENTITY_FALLBACK_NAME,
      city: '',
    });

    type CommentOutcome =
      | { status: 'duplicate'; entry: Record<string, any> }
      | { status: 'conflict'; entry: null }
      | { status: 'created'; entry: Record<string, any> };

    const outcome = await withProfileRow<CommentOutcome>(strapi, targetRow.documentId, (row) => {
      const comments = toArray(row.incomingProfileComments ?? row.incomingComments);
      const existing = comments.find(
        (c: any) => String(c?.operationId ?? '').trim() === operationId,
      ) as Record<string, any> | undefined;
      if (existing) {
        if (String(existing?.fingerprint ?? '').trim() === fingerprint) {
          return {
            data: {},
            result: { status: 'duplicate', entry: existing },
          };
        }
        return { data: {}, result: { status: 'conflict', entry: null } };
      }
      const entry = {
        id: `pc_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
        fromName: profile.name,
        fromProfileId: identity.ownerId,
        fromEmail: identity.email,
        avatarUrl: profile.avatarUrl,
        text,
        timeText: 'Şimdi',
        rating,
        operationId,
        fingerprint,
        createdAt: new Date().toISOString(),
      };
      const nextComments = [entry, ...comments];
      return {
        data: {
          incomingProfileComments: nextComments,
          incomingCommentsUpdatedAt: new Date().toISOString(),
        },
        result: { status: 'created', entry },
      };
    });
    if (!outcome) return ctx.notFound('Hedef profil bulunamadi.');

    if (outcome.status === 'conflict') {
      return ctx.badRequest('Bu operationId farkli bir istekle daha once kullanilmis.');
    }
    ctx.body = { data: outcome.entry };
  },

  /**
   * Soru/Profil/Kart denetimi Madde 14 (rapor -> düzeltme -> kilidin
   * kapsamı): the ONLY real write path that updates BOTH sides of a
   * follow relationship in one server-controlled action -- the caller's
   * own followingIds (which the old client-direct write already updated
   * correctly) AND the target's followerIds (which no write path ever
   * touched before this). Follow is Set-membership, not a counter:
   * adding the same id twice is a no-op by construction (idempotent, no
   * operationId needed), so a double-tap/retry can never inflate a
   * follower count. The caller's own row is created (OUTSIDE the locked
   * transaction, since it cannot deadlock with anything -- a brand-new
   * row no other transaction can be holding a lock on yet) on first use
   * if it does not exist.
   *
   * Both rows are now locked and written inside ONE transaction, in a
   * fixed order (withTwoProfileRows) -- not two separate transactions
   * like before. A concurrent, genuinely reciprocal A-follows-B /
   * B-follows-A never deadlocks (both lock the same two rows in the same
   * sorted order; the second simply waits for the first).
   */
  async followProfile(ctx: any) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

    const targetProfileId = String(ctx.params?.profileId ?? '').trim();
    if (!targetProfileId) return ctx.badRequest('profileId zorunlu.');
    if (targetProfileId === identity.ownerId) {
      return ctx.badRequest('Kendi kendinizi takip edemezsiniz.');
    }

    const targetRow = await strapi.db.query(UID).findOne({ where: { profileId: targetProfileId } });
    if (!targetRow) return ctx.notFound('Hedef profil bulunamadi.');

    let viewerRow = await strapi.db.query(UID).findOne({ where: { profileId: identity.ownerId } });
    if (!viewerRow) {
      viewerRow = await strapi.entityService.create(UID as any, {
        data: { profileId: identity.ownerId, ownerEmail: identity.email },
      });
    }

    const ok = await withTwoProfileRows(
      strapi,
      targetRow.documentId,
      viewerRow.documentId,
      (targetFresh, viewerFresh) => {
        const followers = new Set(toStringArray(targetFresh.followerIds));
        followers.add(identity.ownerId);
        const following = new Set(toStringArray(viewerFresh.followingIds));
        following.add(targetProfileId);
        const nowIso = new Date().toISOString();
        return {
          dataA: { followerIds: [...followers], followUpdatedAt: nowIso },
          dataB: { followingIds: [...following], followUpdatedAt: nowIso },
        };
      },
    );
    if (!ok) return ctx.notFound('Hedef profil bulunamadi.');

    ctx.body = { data: { ok: true } };
  },

  /**
   * Soru/Profil/Kart denetimi Madde 14/15/16 (eşzamanlılık/takip
   * toplamı): symmetric unfollow -- removes the caller from the target's
   * followerIds AND the target from the caller's own followingIds, both
   * server-side, inside ONE locked transaction (withTwoProfileRows, same
   * reasoning as followProfile above). Removing an id that is not
   * present is a no-op (idempotent).
   *
   * Does NOT touch followersFallback/followingFallback at all anymore
   * (an earlier version of this fix decayed it by 1 per genuine
   * unfollow) -- public-profile.ts's computeFollowCount no longer blends
   * that legacy counter into the public-facing total in ANY way, so
   * adjusting it here would serve no purpose. The fallback column is
   * simply never read or written by this action; its stored value in
   * production is left exactly as-is.
   */
  async unfollowProfile(ctx: any) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

    const targetProfileId = String(ctx.params?.profileId ?? '').trim();
    if (!targetProfileId) return ctx.badRequest('profileId zorunlu.');

    const targetRow = await strapi.db.query(UID).findOne({ where: { profileId: targetProfileId } });
    const viewerRow = await strapi.db.query(UID).findOne({ where: { profileId: identity.ownerId } });

    if (targetRow && viewerRow) {
      await withTwoProfileRows(
        strapi,
        targetRow.documentId,
        viewerRow.documentId,
        (targetFresh, viewerFresh) => {
          const followers = new Set(toStringArray(targetFresh.followerIds));
          followers.delete(identity.ownerId);
          const following = new Set(toStringArray(viewerFresh.followingIds));
          following.delete(targetProfileId);
          const nowIso = new Date().toISOString();
          return {
            dataA: { followerIds: [...followers], followUpdatedAt: nowIso },
            dataB: { followingIds: [...following], followUpdatedAt: nowIso },
          };
        },
      );
    } else if (targetRow) {
      await withProfileRow(strapi, targetRow.documentId, (row) => {
        const followers = new Set(toStringArray(row.followerIds));
        followers.delete(identity.ownerId);
        return {
          data: { followerIds: [...followers], followUpdatedAt: new Date().toISOString() },
          result: null,
        };
      });
    } else if (viewerRow) {
      await withProfileRow(strapi, viewerRow.documentId, (row) => {
        const following = new Set(toStringArray(row.followingIds));
        following.delete(targetProfileId);
        return {
          data: { followingIds: [...following], followUpdatedAt: new Date().toISOString() },
          result: null,
        };
      });
    }

    ctx.body = { data: { ok: true } };
  },

  /**
   * Soru/Profil/Kart denetimi Madde 17 (kapanış): incomingProfileComments/
   * incomingComments are now in CLIENT_STRIPPED_FIELDS (a user can no
   * longer PUT a fabricated comments array onto their own row to invent
   * fake glowing reviews) -- but deleting an unwanted REAL comment off
   * your OWN profile is legitimate self-moderation, not self-inflation,
   * and the generic update was its only write path before that strip.
   * This narrow action only ever removes one entry BY ID, never accepts
   * a client-supplied replacement array, and only from the CALLER's own
   * document -- mirrors deleteFarmerQuestionAnswer's own authorization
   * shape (owner-only, remove-one-entry, never add/rewrite).
   */
  async deleteProfileComment(ctx: any) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

    const routeProfileId = String(ctx.params?.profileId ?? '').trim();
    const commentId = String(ctx.params?.commentId ?? '').trim();
    if (!routeProfileId || !commentId) return ctx.badRequest('profileId ve commentId zorunlu.');
    if (routeProfileId !== identity.ownerId) {
      return ctx.forbidden('Yalnizca kendi profilinizdeki bir yorumu silebilirsiniz.');
    }

    const ownRow = await strapi.db.query(UID).findOne({ where: { profileId: identity.ownerId } });
    if (!ownRow) return ctx.notFound('Profil bulunamadi.');

    await withProfileRow(strapi, ownRow.documentId, (row) => {
      const comments = toArray(row.incomingProfileComments ?? row.incomingComments);
      const nextComments = comments.filter((c: any) => String(c?.id ?? '').trim() !== commentId);
      return {
        data: {
          incomingProfileComments: nextComments,
          incomingCommentsUpdatedAt: new Date().toISOString(),
        },
        result: nextComments,
      };
    });

    ctx.body = { data: { ok: true } };
  },
}));
