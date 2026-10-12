/**
 * hub-content controller
 */

import { factories } from '@strapi/strapi';
import {
  canonicalFarmerQuestionId,
  isDeletedOrHiddenState,
  isFarmerQuestionKind,
  loadEntityByRouteId,
  matchesIdentity,
  readIdentity,
  resolveActorProfile,
} from '../../../utils/identity';
import { fingerprintPayload, isValidOperationId, resolveOperation } from '../../../utils/operation-idempotency';
import { createDomainEventNotification } from '../../notification/controllers/notification';

const UID = 'api::hub-content.hub-content';

/**
 * Faz D6-B: `likes` (and `engagementVersion`) must never be settable
 * through the generic create/update actions. engagement_interactions
 * (via setMembership) is the only real source of truth for the like
 * counter now; the pre-D6 Flutter client (HubContentRepo._syncLike)
 * still PATCHes a client-computed absolute `likes` value here as a
 * best-effort sync — unlike the equivalent processed-product gap (Faz
 * D5-B), this one is NOT blocked by a missing permission:
 * hub-content.update is granted to the authenticated role (src/index.ts),
 * and hub-content-write-guard's "reaction-only update" allowance means
 * this path is live and reachable today, not just theoretically so.
 *
 * Only `likes`/`engagementVersion` are stripped — every comment-related
 * field (`comments`, `commentCount`, `commentList`, `lastCommentText`,
 * `lastCommentAuthor`, `lastCommentAt`) goes through this exact same
 * generic update action (HubContentRepo.addComment/_syncCommentListToStrapi)
 * and must keep working unchanged; the comment system is explicitly out
 * of scope for Faz D6.
 */
const ENGAGEMENT_ONLY_FIELDS = ['likes', 'engagementVersion'];

const stripEngagementFields = (data: Record<string, any>): Record<string, any> => {
  const next = { ...data };
  for (const field of ENGAGEMENT_ONLY_FIELDS) delete next[field];
  return next;
};

export default factories.createCoreController(UID as any, ({ strapi }) => ({
  async create(ctx: any) {
    // ENGAGEMENT_E1_TARGETED_FIX_REPORT.md BUG-ENG-001: ownerEmail/
    // ownerProfileId are the row's real, canonical identity fields (added
    // in this fix -- hub-content previously had no identity field at all,
    // only a cosmetic authorName string). Always server-stamped from the
    // authenticated session, never from client-supplied ownerId/
    // ownerEmail/profileId/email/author-style fields, which are ignored
    // for this purpose.
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');
    const body = (ctx.request?.body ?? {}) as Record<string, any>;
    const input = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, any>;
    const data = stripEngagementFields(input);
    data.ownerEmail = identity.email;
    data.ownerProfileId = identity.ownerId;
    ctx.request.body = { data };
    return super.create(ctx);
  },

  async update(ctx: any) {
    const body = (ctx.request?.body ?? {}) as Record<string, any>;
    const input = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, any>;
    const data = stripEngagementFields(input);
    // Ownership is immutable once set at create time -- no update (by the
    // owner or anyone else) may reassign a row's real owner.
    delete data.ownerEmail;
    delete data.ownerProfileId;
    ctx.request.body = { data };
    return super.update(ctx);
  },

  /**
   * "Çiftçiden Sorular" audit follow-up (kalan sınır: erişim kontrolü
   * yalnızca Flutter tarafında mıydı?): the generic `findOne` route had
   * NO policy and no override at all -- a deleted/archived/hidden/
   * blocked row (any kind, not just farmerQuestion) was still served in
   * full by a direct `GET /hub-contents/:id`, regardless of what the
   * Flutter client chose to display. Client-side filtering
   * (farmer_questions_repo.dart's `_isDeletedOrHiddenRow`/
   * `_isQuestionKind`) only ever decided what the APP shows; it never
   * restricted what the SERVER hands back to anyone who asks directly.
   * Mirrors the exact pattern `listing.ts`'s own `findOne` override
   * already established for listings (non-owner + non-"active" ->
   * notFound) -- same shape, now applied to hub-content too.
   */
  async findOne(ctx: any) {
    const rawId = String(ctx.params?.id ?? '').trim();
    if (!rawId) return ctx.notFound('Icerik bulunamadi.');
    const row = await loadEntityByRouteId(strapi, UID, rawId, [
      'id',
      'documentId',
      'kind',
      'state',
      'ownerEmail',
      'ownerProfileId',
    ]);
    if (!row) return ctx.notFound('Icerik bulunamadi.');
    const identity = readIdentity(ctx);
    const isOwner =
      !!identity &&
      matchesIdentity(row as Record<string, unknown>, identity, ['ownerEmail'], ['ownerProfileId']);
    if (!isOwner && isDeletedOrHiddenState(row as Record<string, unknown>)) {
      return ctx.notFound('Icerik bulunamadi.');
    }
    return super.findOne(ctx);
  },

  /**
   * "Çiftçiden Sorular" audit follow-up (Maddeler 1-3): a dedicated,
   * SERVER-VERIFIED way to answer a farmer question, replacing the old
   * client-driven full-row PUT (farmer_questions_repo.dart's addAnswer)
   * that re-sent the question's entire embedded `answers` JSON array --
   * including each answer's OWN name/profileId/email, never
   * independently checked against who actually sent the request (Madde
   * 1), and racy under concurrent answers since two overlapping full-row
   * PUTs can each overwrite the other's in-flight append (Madde 2).
   *
   * This creates a SEPARATE hub-content row (kind='farmerQuestionComment')
   * per answer -- a plain INSERT, never a read-modify-write of a shared
   * blob, so concurrent answers from different users can never race or
   * lose one another; each is independently durable the moment its own
   * request commits. The existing read path (farmer_questions_repo.dart's
   * refresh()) ALREADY merges these "legacy-shaped" standalone comment
   * rows together with any embedded answers from older rows (dedup by
   * signature) -- this was always a supported SHAPE on read, just not
   * the one new answers were being WRITTEN as. Historical answers
   * embedded in a question's own body JSON are untouched (never
   * rewritten, never re-stamped with a new "author").
   *
   * Identity (Madde 1): name/city resolved from the ANSWERER's own
   * profile-setting row; profileId/email always the authenticated
   * caller's real identity -- never trusted from client input, so a
   * caller cannot author an answer as (or attributed to) anyone else.
   *
   * Idempotency (Madde 2): a client-generated UUID operationId
   * (ENGAGEMENT_API_CONTRACT.md's established comment/share pattern,
   * api/engagement's own resolveOperation) makes a retried submission of
   * the SAME answer return the already-created row instead of a second
   * one; a reused operationId with different content is rejected as a
   * conflict, matching messages'/engagement's own established contract.
   *
   * Notification (Madde 3): fires exactly once per successfully-created
   * (non-duplicate) answer, to the QUESTION's real, server-loaded owner
   * -- never the client's claim -- skipped entirely when the answerer
   * IS the question's own owner (self-answer).
   */
  async addFarmerQuestionAnswer(ctx: any) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

    const questionRouteId = String(ctx.params?.questionId ?? '').trim();
    if (!questionRouteId) return ctx.badRequest('questionId zorunlu.');

    const body = (ctx.request?.body ?? {}) as Record<string, any>;
    const input = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, any>;
    const text = String(input.text ?? '').trim();
    if (!text) return ctx.badRequest('Cevap metni bos olamaz.');

    const operationId = String(input.operationId ?? '').trim();
    if (!isValidOperationId(operationId)) {
      return ctx.badRequest('Gecerli bir operationId gerekli.');
    }

    // Load the REAL question row -- never trust a client-claimed kind or
    // owner. Rejects anything that isn't actually a farmerQuestion-kind
    // row (a spoofed questionId pointing at an unrelated blog/report row
    // must not let a caller attach an "answer" to it) and anything
    // deleted/archived/hidden (not "accessible").
    const question = await loadEntityByRouteId(strapi, UID, questionRouteId, [
      'id',
      'documentId',
      'kind',
      'state',
      'title',
      'ownerEmail',
      'ownerProfileId',
      'body',
    ]);
    if (!question) return ctx.notFound('Soru bulunamadi.');
    if (!isFarmerQuestionKind((question as any).kind)) {
      return ctx.badRequest('Bu kayit bir ciftci sorusu degil.');
    }
    const qState = String((question as any).state ?? '').trim().toLowerCase();
    if (
      qState.includes('delete') ||
      qState.includes('archive') ||
      qState.includes('block') ||
      qState.includes('remove') ||
      qState.includes('hidden')
    ) {
      return ctx.notFound('Soru bulunamadi.');
    }

    const fingerprint = fingerprintPayload({
      questionId: questionRouteId,
      text,
      actor: identity.ownerId,
    });
    const resolution = await resolveOperation(strapi, UID, operationId, fingerprint);
    if (resolution.status === 'conflict') {
      return ctx.badRequest('Bu operationId farkli bir istekle daha once kullanilmis.');
    }

    const canonicalQuestionId = canonicalFarmerQuestionId(question as Record<string, unknown>);

    const respondWith = (row: Record<string, any>) => {
      let answerBody: Record<string, unknown> = {};
      try {
        answerBody = JSON.parse(String(row.body ?? '{}'));
      } catch (_) {
        answerBody = {};
      }
      ctx.body = {
        data: {
          id: String(answerBody.answerId ?? `fa_${row.id}`),
          questionId: String(answerBody.questionId ?? canonicalQuestionId),
          name: String(answerBody.name ?? ''),
          city: String(answerBody.city ?? ''),
          text: String(answerBody.text ?? ''),
          createdAt: String(answerBody.createdAt ?? row.createdAt ?? ''),
          avatarUrl: String(answerBody.avatarUrl ?? ''),
          profileId: String(answerBody.profileId ?? ''),
          email: String(answerBody.email ?? ''),
        },
      };
    };

    if (resolution.status === 'duplicate') {
      // Same operationId, same content -- the original answer already
      // exists; hand it back rather than creating a second row. No new
      // notification either (see below: only a true first-time create
      // triggers one).
      respondWith(resolution.existing as Record<string, any>);
      return;
    }

    const fallbackName = identity.email.split('@')[0] || 'Kullanıcı';
    const profile = await resolveActorProfile(strapi, identity.ownerId, {
      name: fallbackName,
      city: 'Türkiye',
    });

    const answerId = `fa_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const nowIso = new Date().toISOString();
    const answerBody = {
      questionId: canonicalQuestionId,
      answerId,
      text,
      name: profile.name,
      city: profile.city,
      profileId: identity.ownerId,
      email: identity.email,
      createdAt: nowIso,
    };

    let created: Record<string, any>;
    try {
      created = (await strapi.entityService.create(UID as any, {
        data: {
          kind: 'farmerQuestionComment',
          state: 'published',
          ownerEmail: identity.email,
          ownerProfileId: identity.ownerId,
          authorName: profile.name,
          title: canonicalQuestionId,
          descShort: text.length > 160 ? `${text.slice(0, 160)}...` : text,
          body: JSON.stringify(answerBody),
          operationId,
          payloadFingerprint: fingerprint,
          createdAtClient: nowIso,
        },
      })) as Record<string, any>;
    } catch (e) {
      // Concurrent retry already inserted the same operationId first --
      // re-resolve and return the winner's row idempotently instead of
      // propagating a raw unique-constraint error (same pattern
      // conversation.ts's sendMessage already established).
      const retry = await resolveOperation(strapi, UID, operationId, fingerprint);
      if (retry.status === 'duplicate') {
        respondWith(retry.existing as Record<string, any>);
        return;
      }
      throw e;
    }

    // Madde 3: notify the question's REAL owner -- server-loaded above,
    // never the client's claim -- skipped automatically if the answerer
    // IS that owner (self-answer). dedupKey includes the answerId so
    // EACH distinct answer notifies once, while a retry of this exact
    // answer (caught as 'duplicate' above, never reaching this line)
    // never fires a second one.
    const ownerEmail = String((question as any).ownerEmail ?? '').trim().toLowerCase();
    const ownerProfileId = String((question as any).ownerProfileId ?? '').trim();
    if (ownerEmail || ownerProfileId) {
      await createDomainEventNotification(strapi, {
        domain: 'farmer_question',
        event: 'answer',
        entityId: canonicalQuestionId,
        identity,
        owner: { email: ownerEmail, ownerId: ownerProfileId },
        dedupKey: `${identity.ownerId}_${answerId}`,
        messageOverride: text,
        extra: { questionId: canonicalQuestionId, answerId },
      });
    }

    respondWith(created);
  },
}));
