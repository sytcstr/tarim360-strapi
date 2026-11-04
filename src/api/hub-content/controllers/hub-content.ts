/**
 * hub-content controller
 */

import { factories } from '@strapi/strapi';
import {
  canonicalFarmerQuestionId,
  isDeletedOrHiddenState,
  isFarmerQuestionKind,
  isFarmerQuestionReportKind,
  isOwnerAlsoHiddenFarmerQuestionState,
  loadEntityByRouteId,
  matchesIdentity,
  readIdentity,
  resolveActorProfile,
  resolveFarmerQuestionOwnerByAnyId,
} from '../../../utils/identity';
import { fingerprintPayload, isValidOperationId, resolveOperation } from '../../../utils/operation-idempotency';
import { createDomainEventNotification } from '../../notification/controllers/notification';
import {
  applyFarmerQuestionReadGuards,
  buildHubContentVisibilityFilter,
  embeddedAnswerBelongsToIdentity,
  FARMER_IDENTITY_FALLBACK_NAME,
  stampFarmerIdentityIntoBody,
} from '../../../utils/farmer-question-privacy';

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
    // Soru/Profil/Kart denetimi (2026-10-25) Madde 1/3/4: the row's real
    // access-control owner is now locked above, but a farmerQuestion's
    // visible "who asked" identity (authorEmail/authorProfileId/
    // authorName/authorCity/authorAvatarUrl) and a farmerQuestionReport's
    // "who reported" identity (reporterEmail/reporterProfileId/
    // reporterName/reporterCity) live inside the client-authored `body`
    // JSON and were never checked -- a caller could claim to be a
    // different real person, or show a different real person's name/
    // city/avatar. Derived from the real session AND that session's own
    // verified profile-setting row -- see farmer-question-privacy.ts's
    // own doc comment.
    data.body = await stampFarmerIdentityIntoBody(strapi, data.kind, data.body, identity);

    // Soru/Profil/Kart denetimi Madde 12 (kapanış): a user may not report
    // their own question -- rejected here, BEFORE any row is created,
    // never left to client-side UI alone. Scoped strictly to
    // targetType==='question' (reporting one's own ANSWER is a separate,
    // not-requested item). The report's real target owner is resolved
    // from the SERVER's own stored row (resolveFarmerQuestionOwnerByAnyId),
    // never trusted from the client-claimed questionId's ownership.
    if (isFarmerQuestionReportKind(data.kind)) {
      let reportBody: Record<string, unknown> | null = null;
      try {
        reportBody = JSON.parse(String(data.body ?? '{}'));
      } catch (_) {
        reportBody = null;
      }
      const targetType = String(reportBody?.targetType ?? '').trim().toLowerCase();
      // `questionId` alone is a client-synthetic canonical string (e.g.
      // `fq_<local-timestamp>`) that this server cannot reliably resolve
      // back to a real row -- `questionRemoteId` (the row's own real,
      // server-issued id, sent by the client's own reportQuestion/
      // reportAnswer) is tried first; `questionId` stays as a best-effort
      // fallback for any caller that does not yet send it.
      const questionRemoteId = String(reportBody?.questionRemoteId ?? '').trim();
      const questionId = String(reportBody?.questionId ?? '').trim();
      const lookupId = questionRemoteId || questionId;
      if (targetType === 'question' && lookupId) {
        const owner = await resolveFarmerQuestionOwnerByAnyId(strapi, lookupId);
        if (owner && (owner.email === identity.email || owner.ownerId === identity.ownerId)) {
          return ctx.badRequest('Kendi sorunuzu sikayet edemezsiniz.');
        }
      }
    }

    // Soru/Profil/Kart denetimi (2026-10-25) Madde 8: question creation
    // had NO idempotency at all (unlike addFarmerQuestionAnswer, which
    // already reuses this exact mechanism) -- a double-tap, a client-
    // level retry, or a genuinely-ambiguous "server saved it but the
    // response was lost" case could each create a real duplicate
    // question. Opt-in via a CLIENT-SUPPLIED `operationId` (a UUID, same
    // field/shape already used for answers): if the client sends one,
    // it is validated and deduped exactly like an answer's; if it sends
    // NONE (every pre-existing app build, and every other hub-content
    // kind), creation proceeds exactly as before -- this can never
    // reject or alter a request that doesn't opt in.
    //
    // Scoped to farmerQuestion only: a blog/Knowledge Hub create (or any
    // other kind) never sends operationId today, and this must not
    // start requiring or interpreting one for them.
    let operationIdForCreate = '';
    let fingerprintForCreate = '';
    if (isFarmerQuestionKind(data.kind)) {
      const rawOperationId = typeof data.operationId === 'string' ? data.operationId.trim() : '';
      if (rawOperationId) {
        if (!isValidOperationId(rawOperationId)) {
          return ctx.badRequest('operationId gecerli bir UUID olmali.');
        }
        // Actor is part of the fingerprint: two DIFFERENT real users can
        // never collide on the same client-generated operationId in
        // practice (it's a UUID), but if one ever tried to replay
        // another user's operationId with their OWN content, the
        // mismatched actor alone makes the fingerprint differ from
        // whatever the original caller's row stored -- a 'conflict'
        // (400), never a silent takeover of someone else's row. Title/
        // body are the STAMPED values (post stampFarmerIdentityIntoBody
        // above), which are deterministic for the same real actor, so a
        // genuine retry of the exact same attempt always re-derives the
        // identical fingerprint.
        const fingerprint = fingerprintPayload({
          actor: identity.ownerId,
          title: String(data.title ?? ''),
          descShort: String(data.descShort ?? ''),
          body: String(data.body ?? ''),
        });
        const resolution = await resolveOperation(strapi, UID, rawOperationId, fingerprint);
        if (resolution.status === 'conflict') {
          return ctx.badRequest('Bu operationId farkli bir istekle daha once kullanilmis.');
        }
        if (resolution.status === 'duplicate') {
          // The exact same attempt already created a real row -- hand
          // that back instead of creating a second one. Deliberately
          // never merges two DIFFERENT, deliberately separate questions
          // just because their title/body text happens to match: this
          // lookup is keyed ONLY by operationId, never by fingerprint
          // alone, so two genuinely distinct submissions (each with
          // their own operationId) can never collapse into one even if
          // their content is word-for-word identical.
          ctx.body = { data: resolution.existing };
          return;
        }
        data.operationId = rawOperationId;
        data.payloadFingerprint = fingerprint;
        operationIdForCreate = rawOperationId;
        fingerprintForCreate = fingerprint;
      } else {
        delete data.operationId;
      }
    } else {
      delete data.operationId;
    }

    ctx.request.body = { data };
    try {
      return await super.create(ctx);
    } catch (e) {
      // Two truly concurrent requests with the SAME operationId can both
      // pass the resolveOperation check above (neither has committed
      // yet) and then race on the schema's own unique constraint here --
      // same pattern conversation.ts's sendMessage and
      // addFarmerQuestionAnswer above already handle: re-resolve and
      // hand back whichever one actually won, instead of propagating a
      // raw DB constraint error.
      if (operationIdForCreate) {
        const retry = await resolveOperation(strapi, UID, operationIdForCreate, fingerprintForCreate);
        if (retry.status === 'duplicate') {
          ctx.body = { data: retry.existing };
          return;
        }
      }
      throw e;
    }
  },

  async update(ctx: any) {
    const identity = readIdentity(ctx);
    const body = (ctx.request?.body ?? {}) as Record<string, any>;
    const input = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, any>;
    const data = stripEngagementFields(input);
    // Ownership is immutable once set at create time -- no update (by the
    // owner or anyone else) may reassign a row's real owner.
    delete data.ownerEmail;
    delete data.ownerProfileId;
    // Soru/Profil/Kart denetimi (2026-10-25) Madde 2: create() AND update()
    // must be protected together -- otherwise a row's own owner could PUT
    // a full-row update and rewrite their OWN visible author*/reporter*
    // identity to claim a different real person, even though the
    // access-control owner fields above stay locked. The real `kind` is
    // read from the EXISTING row (never trusted from a client-omitted/
    // altered `kind` on a partial update), so this still applies even
    // when this specific request doesn't resend `kind`. Deliberately
    // never touches the embedded `answers[]` array -- stamping the
    // question's OWN author fields must never reassign an already-
    // written answer's real author to the question's owner.
    if (identity && typeof data.body !== 'undefined') {
      const rawId = String(ctx.params?.id ?? '').trim();
      const existing = rawId ? await loadEntityByRouteId(strapi, UID, rawId, ['kind']) : null;
      const kindForStamp = data.kind ?? (existing as any)?.kind;
      data.body = await stampFarmerIdentityIntoBody(strapi, kindForStamp, data.body, identity);
    }
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
      'deleted',
      'isDeleted',
    ]);
    if (!row) return ctx.notFound('Icerik bulunamadi.');
    const identity = readIdentity(ctx);
    const isOwner =
      !!identity &&
      matchesIdentity(row as Record<string, unknown>, identity, ['ownerEmail'], ['ownerProfileId']);
    if (isDeletedOrHiddenState(row as Record<string, unknown>)) {
      const isFarmerQuestion = isFarmerQuestionKind((row as any).kind);
      // Soru/Profil/Kart denetimi Madde 10-11 (kapanış): the owner's
      // unconditional bypass is preserved for every hidden state as
      // before (block/hidden/draft/unpublish/etc. -- moderation states
      // the owner must still see); it is narrowed ONLY for a
      // farmerQuestion row whose state is the old, ambiguous plain
      // 'archived' marker or the new 'farmerQuestionDeleted' soft-delete
      // marker (isOwnerAlsoHiddenFarmerQuestionState's own doc comment).
      // The new 'farmerQuestionArchived' marker keeps the owner's bypass
      // ("arşivli soruyu sahibi görebilsin").
      const ownerBypass =
        isOwner &&
        (!isFarmerQuestion ||
          !isOwnerAlsoHiddenFarmerQuestionState(row as Record<string, unknown>));
      if (!ownerBypass) {
        return ctx.notFound('Icerik bulunamadi.');
      }
    }
    // Soru/Profil/Kart denetimi (2026-10-25) Madde 2: the hidden/deleted
    // check above already decided this row IS visible to this caller;
    // this additionally strips a farmer-question-family row's own
    // embedded email field(s) from `body` for anyone but the real owner.
    return applyFarmerQuestionReadGuards(await super.findOne(ctx), identity);
  },

  /**
   * Soru/Profil/Kart denetimi (2026-10-25) Madde 1: unlike `findOne`
   * above, this route had NO override at all -- a hidden/archived/
   * deleted/blocked row (any kind) was returned in full by the public,
   * unauthenticated list endpoint, even though a direct single-row fetch
   * of the exact same row was already correctly blocked. Client-side
   * filtering (farmer_questions_repo.dart's `_isDeletedOrHiddenRow`) only
   * ever decided what the APP shows; it never restricted what the SERVER
   * handed back to anyone who queried the list directly. Applies the
   * SAME generic, kind-agnostic rule `findOne` already used (not a new,
   * farmer-question-specific policy), so other hub-content kinds (blog/
   * Knowledge Hub) keep behaving exactly as before for any row that is
   * NOT in a hidden/deleted state -- only a row that was already
   * unreachable via findOne becomes unreachable via find too.
   */
  async find(ctx: any) {
    const identity = readIdentity(ctx);
    // Soru/Profil/Kart denetimi Madde 4: the visibility rule is applied
    // as a REAL query filter (AND-wrapped with whatever the caller's own
    // `filters` already specified, same safe pattern listing.ts's own
    // find() override uses), so Strapi's own pagination/count math runs
    // against the already-filtered set -- never a fetch-then-discard
    // that would shrink a page or leak a hidden-inclusive total count.
    const previous = (ctx.query ?? {}) as Record<string, unknown>;
    const rawFilters =
      previous.filters && typeof previous.filters === 'object' ? (previous.filters as Record<string, unknown>) : null;
    const visibilityFilter = buildHubContentVisibilityFilter(identity);
    ctx.query = {
      ...previous,
      filters: rawFilters ? { $and: [rawFilters, visibilityFilter] } : visibilityFilter,
    } as any;
    return applyFarmerQuestionReadGuards(await super.find(ctx), identity);
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

    // Kapanış kontrolü (2026-10-25): email'in @ öncesi kısmı fallback adı
    // olarak kullanılırsa, e-postanın bir parçası yine herkese açık
    // "görünen ad" olarak sızar -- aynı sabit, aynı sebeple
    // stampFarmerIdentityIntoBody'nin de kullandığı
    // FARMER_IDENTITY_FALLBACK_NAME ('Kullanıcı').
    const profile = await resolveActorProfile(strapi, identity.ownerId, {
      name: FARMER_IDENTITY_FALLBACK_NAME,
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

  /**
   * Soru/Profil/Kart denetimi (2026-10-25) Madde 5: `deleteAnswerByIds`
   * (farmer_questions_repo.dart) used to "delete" an answer by removing
   * it from the client's own in-memory list, then PUTting the QUESTION's
   * full row back with the remaining embedded answers -- this only ever
   * does anything real for the legacy EMBEDDED-answer shape; a modern
   * STANDALONE answer row (kind=farmerQuestionComment, created via
   * addFarmerQuestionAnswer above) is never touched by that PUT at all,
   * since it was never part of the question's own `body`. The PUT could
   * also be flatly REJECTED (403) when the caller is the answer's own
   * author but not the question's owner (hub-content-write-guard.ts only
   * allows a non-owner a reaction-only update on this kind) -- and the
   * old client code swallowed that failure and reported success anyway.
   *
   * This dedicated, server-verified endpoint actually deletes the right
   * row for EITHER shape, with the exact same authorization the existing
   * UI already assumes (`_canDeleteAnswer = _isQuestionOwner() ||
   * _isAnswerOwner(a)` in farmer_question_detail_page.dart) -- never
   * more. It does NOT touch, loosen, or route through
   * hub-content-write-guard's generic PUT/PATCH policy at all; the
   * question's own `body` write for the embedded case is a narrow,
   * server-controlled "remove exactly this one entry, keep every other
   * byte-identical" operation, not a client-supplied full-body PUT.
   */
  async deleteFarmerQuestionAnswer(ctx: any) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

    const questionRouteId = String(ctx.params?.questionId ?? '').trim();
    const answerId = String(ctx.params?.answerId ?? '').trim();
    if (!questionRouteId || !answerId) {
      return ctx.badRequest('questionId ve answerId zorunlu.');
    }

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

    const isQuestionOwner = matchesIdentity(
      question as Record<string, unknown>,
      identity,
      ['ownerEmail'],
      ['ownerProfileId'],
    );
    const canonicalQuestionId = canonicalFarmerQuestionId(question as Record<string, unknown>);

    // Case 1: a legacy answer embedded directly in the question's own body.
    let embeddedParsed: any = null;
    try {
      embeddedParsed = JSON.parse(String((question as any).body ?? '{}'));
    } catch (_) {
      embeddedParsed = null;
    }
    const embeddedAnswers = Array.isArray(embeddedParsed?.answers) ? embeddedParsed.answers : null;
    if (embeddedAnswers) {
      const matchIndex = embeddedAnswers.findIndex(
        (a: any) => String(a?.answerId ?? '').trim() === answerId,
      );
      if (matchIndex !== -1) {
        const matchedAnswer = embeddedAnswers[matchIndex];
        if (!isQuestionOwner && !embeddedAnswerBelongsToIdentity(matchedAnswer, identity)) {
          return ctx.forbidden('Bu cevabi silme yetkiniz yok.');
        }
        const remaining = embeddedAnswers.filter((_: any, i: number) => i !== matchIndex);
        await strapi.entityService.update(UID as any, (question as any).id, {
          data: { body: JSON.stringify({ ...embeddedParsed, answers: remaining }) },
        } as any);
        ctx.body = { data: { deleted: true, answerId, mode: 'embedded' } };
        return;
      }
    }

    // Case 2: a standalone farmerQuestionComment row. addFarmerQuestionAnswer
    // stamps `title: canonicalQuestionId` on every such row specifically so
    // it can be looked up by question without scanning unrelated kinds.
    const candidates = (await strapi.db.query(UID).findMany({
      where: { kind: 'farmerQuestionComment', title: canonicalQuestionId },
      select: ['id', 'documentId', 'ownerEmail', 'ownerProfileId', 'body'],
    } as any)) as Record<string, any>[];
    const standaloneRow = candidates.find((row) => {
      try {
        const parsed = JSON.parse(String(row.body ?? '{}'));
        return String(parsed?.answerId ?? '').trim() === answerId;
      } catch (_) {
        return false;
      }
    });
    if (!standaloneRow) {
      return ctx.notFound('Cevap bulunamadi.');
    }
    const isAnswerOwner = matchesIdentity(standaloneRow, identity, ['ownerEmail'], ['ownerProfileId']);
    if (!isQuestionOwner && !isAnswerOwner) {
      return ctx.forbidden('Bu cevabi silme yetkiniz yok.');
    }
    await strapi.entityService.delete(UID as any, standaloneRow.id as any);
    ctx.body = { data: { deleted: true, answerId, mode: 'standalone' } };
  },
}));
