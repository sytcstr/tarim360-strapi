import { factories } from '@strapi/strapi';
import {
  loadEntityByRouteId,
  matchesIdentity,
  readIdentity,
  resolveFarmerQuestionOwnerByAnyId,
  resolveListingOwnerByAnyId,
  resolveLogisticsLoadOwnerByAnyId,
  resolveProcessedProductOwnerByAnyId,
  resolveProfileOwnerIfExists,
  type SessionIdentity,
} from '../../../utils/identity';

const UID = 'api::notification.notification';

/**
 * NOTIFICATION_N1_SECURITY_FIX_REPORT.md BUG-NOTIF-001: the server-
 * authoritative replacement for the "social interaction" notifications
 * (favorite/like on a listing/logistics-load/processed-product, a
 * comment/favorite on a profile) that used to go through the generic,
 * client-target-trusting POST /api/notifications. The client supplies
 * only an entityId and an event; the recipient AND the title/message are
 * entirely server-derived from that entity's own real, stored owner
 * field -- never from client input. Unknown/unresolvable entityId is
 * rejected rather than silently no-op'd, so a client can't probe for
 * which ids exist.
 *
 * "Çiftçiden Sorular" audit follow-up: farmer_question was added here
 * once hub-content gained real ownerEmail/ownerProfileId fields (see
 * hub-content-write-guard.ts's own BUG-ENG-001 history). Its `like`
 * event additionally requires a real, currently-active
 * engagement-interaction row before notifying (see createDomainEvent
 * below), and its `answer` event is rejected outright there -- that one
 * is only ever produced server-to-server from hub-content.ts's
 * addFarmerQuestionAnswer, which calls createDomainEventNotification
 * directly and never reaches this HTTP action.
 */
const DOMAIN_EVENTS: Record<
  string,
  { events: Record<string, { kind: string; title: string; message: string }> }
> = {
  listing: {
    events: {
      favorite: { kind: 'favorite', title: 'İlanın Favorilendi', message: 'ilanını favorilerine ekledi.' },
      like: { kind: 'like', title: 'İlanın Beğenildi', message: 'ilanını beğendi.' },
    },
  },
  logistics_load: {
    events: {
      favorite: { kind: 'favorite', title: 'Yük İlanın Favorilendi', message: 'yük ilanını favorilerine ekledi.' },
      like: { kind: 'like', title: 'Yük İlanın Beğenildi', message: 'yük ilanını beğendi.' },
    },
  },
  processed_product: {
    events: {
      favorite: { kind: 'favorite', title: 'Ürünün Favorilendi', message: 'ürününü favorilerine ekledi.' },
      like: { kind: 'like', title: 'Ürünün Beğenildi', message: 'ürününü beğendi.' },
    },
  },
  profile: {
    events: {
      favorite: { kind: 'favorite', title: 'Profilin Favorilendi', message: 'profilini favorilerine ekledi.' },
      comment: { kind: 'comment', title: 'Profiline Yeni Yorum', message: 'profiline yorum yaptı.' },
    },
  },
  // UAT "Çiftçiden Sorular" follow-up fix: farmer_question now HAS a real,
  // verifiable author-identity field (ownerEmail/ownerProfileId, same as
  // every other hub-content row -- see hub-content.ts's create()
  // override), so it moves off the self-target-only generic endpoint
  // onto this same trusted path every other domain already uses. `like`
  // is driven by the client (farmer_question_card.dart, after a
  // confirmed EngagementStore like) via POST /notifications/domain-event
  // exactly like the other domains' like/favorite. `answer` is never
  // called over HTTP by the client at all -- hub-content.ts's
  // addFarmerQuestionAnswer calls createDomainEventNotification directly,
  // server-to-server, right after the answer row itself is verified-
  // created (never a free-standing event call a client could forge to
  // manufacture a fake "someone answered" notification).
  farmer_question: {
    events: {
      like: { kind: 'like', title: 'Soruna Beğeni', message: 'sorunu beğendi.' },
      answer: { kind: 'comment', title: 'Soruna Yeni Yorum', message: 'sorusuna yeni bir yorum ekledi.' },
    },
  },
};

const resolveDomainOwner = async (
  strapi: any,
  domain: string,
  entityId: string,
): Promise<{
  email: string;
  ownerId: string;
  canonicalQuestionId?: string;
  row?: Record<string, unknown>;
} | null> => {
  switch (domain) {
    case 'listing':
      return resolveListingOwnerByAnyId(strapi, entityId);
    case 'logistics_load':
      return resolveLogisticsLoadOwnerByAnyId(strapi, entityId);
    case 'processed_product':
      return resolveProcessedProductOwnerByAnyId(strapi, entityId);
    case 'profile':
      return resolveProfileOwnerIfExists(strapi, entityId);
    case 'farmer_question':
      return resolveFarmerQuestionOwnerByAnyId(strapi, entityId);
    default:
      return null;
  }
};

/**
 * Shared core of createDomainEvent, extracted so hub-content.ts's
 * addFarmerQuestionAnswer can trigger the SAME trusted, server-derived
 * notification path directly (server-to-server, no second HTTP round
 * trip, no client-reachable "just call this event" surface for the
 * answer case) right after it has ALREADY verified-created the answer
 * row and already has the real owner in hand from that same load --
 * never re-deriving anything from client input.
 *
 * `dedupKey` defaults to the sender's own ownerId (the original
 * behavior for listing/logistics_load/processed_product/profile and
 * farmer_question's `like`: at most one stored notification per
 * sender+entity+event, so a rapid like/unlike/like loop or a retried
 * request can never stack up duplicates). farmer_question's `answer`
 * passes a dedupKey that also includes the answer's own id, since
 * EACH distinct answer from the same person is its own real event and
 * must notify -- only a retried POST for the identical answer (same
 * resolved answerId) collapses onto the same notificationId.
 */
export const createDomainEventNotification = async (
  strapi: any,
  params: {
    domain: string;
    event: string;
    entityId: string;
    identity: SessionIdentity;
    owner: { email: string; ownerId: string };
    dedupKey?: string;
    messageOverride?: string;
    extra?: Record<string, unknown>;
  },
): Promise<{ ok: boolean; skipped?: 'self' | 'invalid' }> => {
  const domainConfig = DOMAIN_EVENTS[params.domain];
  const eventConfig = domainConfig?.events[params.event];
  if (!domainConfig || !eventConfig) return { ok: false, skipped: 'invalid' };

  const { owner, identity } = params;
  if (
    (owner.email && owner.email === identity.email) ||
    (owner.ownerId && owner.ownerId === identity.ownerId)
  ) {
    // Self-interaction (e.g. liking/answering your own question) never
    // notifies -- matches every client-side guard this replaces.
    return { ok: true, skipped: 'self' };
  }

  const senderLabel = identity.email.split('@')[0] || 'Bir kullanıcı';
  const dedupKey = (params.dedupKey ?? identity.ownerId).trim() || identity.ownerId;
  const notifData: Record<string, unknown> = {
    notificationId: `${params.domain}_${params.event}_${params.entityId}_${dedupKey}`,
    kind: eventConfig.kind,
    event: params.event,
    source: params.domain,
    title: eventConfig.title,
    message: params.messageOverride?.trim() || `${senderLabel} ${eventConfig.message}`,
    isRead: false,
    senderEmail: identity.email,
    senderProfileId: identity.ownerId,
    createdAtClient: new Date().toISOString(),
    ...(params.extra ?? {}),
  };
  if (owner.email) notifData.targetEmail = owner.email;
  if (owner.ownerId) notifData.targetProfileId = owner.ownerId;

  try {
    await strapi.entityService.create('api::notification.notification' as any, { data: notifData });
  } catch (e) {
    // Deterministic notificationId means a genuine repeat of the same
    // interaction by the same sender hits the unique constraint here
    // instead of creating a duplicate row -- expected, not an error.
    strapi.log.warn(`Domain-event notification skipped: ${String(e)}`);
  }
  return { ok: true };
};

export default factories.createCoreController(UID, ({ strapi }) => ({
  async createDomainEvent(ctx) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const domain = String(body.domain ?? '').trim();
    const event = String(body.event ?? '').trim();
    const entityId = String(body.entityId ?? '').trim();
    if (!entityId) return ctx.badRequest('entityId zorunlu.');

    const domainConfig = DOMAIN_EVENTS[domain];
    const eventConfig = domainConfig?.events[event];
    if (!domainConfig || !eventConfig) {
      return ctx.badRequest('Gecersiz domain veya event.');
    }

    // "Çiftçiden Sorular" audit follow-up (sahte bildirim gap): a
    // farmer_question `answer`/comment notification is only ever
    // produced server-to-server, from inside addFarmerQuestionAnswer
    // right after it has itself verified-created the answer row
    // (hub-content.ts calls createDomainEventNotification directly,
    // never through this HTTP action). No legitimate client flow ever
    // posts `{domain:'farmer_question', event:'answer', ...}` here --
    // allowing it would let anyone send the question's owner a fake
    // "new answer" notification without ever actually answering.
    if (domain === 'farmer_question' && event === 'answer') {
      return ctx.badRequest('Bu event bu yoldan tetiklenemez.');
    }

    const owner = await resolveDomainOwner(strapi, domain, entityId);
    if (!owner || (!owner.email && !owner.ownerId)) {
      return ctx.notFound('Hedef kayit bulunamadi.');
    }

    // "Çiftçiden Sorular" audit follow-up (sahte bildirim gap): unlike
    // `answer` (not reachable here at all, above), `like` IS a real,
    // legitimate client-triggered event -- but this action never
    // verified the caller had actually liked anything first, so any
    // authenticated user could POST a fake "beğendi" notification for
    // any real question id without ever liking it. Require a real,
    // currently-active engagement-interaction row (the same one
    // EngagementStore.toggleLike/setMembership writes) for this exact
    // (actor, question, like) before creating the notification --
    // removing the like later deletes that row, so an unlike can never
    // be followed by a fake replay of the same notification either.
    if (domain === 'farmer_question' && event === 'like') {
      const rowId = String((owner.row as any)?.id ?? '').trim();
      const actorKey = `user:${identity.email.trim().toLowerCase()}`;
      const activeLike = rowId
        ? await strapi.db.query('api::engagement-interaction.engagement-interaction').findOne({
            where: { actorKey, targetType: 'hub-content', targetId: rowId, kind: 'like' },
          })
        : null;
      if (!activeLike) {
        return ctx.badRequest('Bu kayda ait aktif bir begeni bulunamadi.');
      }
    }

    // PRE_UAT_F1_TARGETED_FUNCTIONAL_FIX_REPORT.md F1.3: the entityId was
    // only ever used to resolve the owner, then discarded -- tapping a
    // listing favorite/like notification had no way to recover which
    // listing it was about. Stored under the same `listingId` field the
    // message/offer notification producers already use (farmer_question
    // mirrors this with its own `questionId` field, already on this
    // schema), so the Flutter client's notification-tap navigation can
    // treat all of them the same way.
    const extra: Record<string, unknown> = {};
    if (domain === 'listing') extra.listingId = entityId;
    if (domain === 'farmer_question') {
      extra.questionId = owner.canonicalQuestionId ?? entityId;
    }
    // Madde 3 (like, specifically): matches the exact pre-existing
    // product copy ("{isim} sorunu beğendi: {soru başlığı}") rather than
    // the generic "{isim} {action}." sentence the other domains use --
    // only farmer_question's `like` carries the question's own title
    // this way, since the original client-side producer this replaces
    // already did.
    let messageOverride: string | undefined;
    if (domain === 'farmer_question' && event === 'like') {
      const title = String((owner.row as any)?.title ?? '').trim();
      messageOverride = title
        ? `${identity.email.split('@')[0] || 'Bir kullanıcı'} sorunu beğendi: ${title}`
        : undefined;
    }

    const result = await createDomainEventNotification(strapi, {
      domain,
      event,
      entityId,
      identity,
      owner,
      messageOverride,
      extra,
    });
    ctx.body = { data: { ok: result.ok, ...(result.skipped ? { skipped: result.skipped } : {}) } };
  },
  async markRead(ctx) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

    const rawId = String(ctx.params.notificationId || '').trim();
    if (!rawId) return ctx.badRequest('notificationId zorunlu.');

    let entity = await loadEntityByRouteId(strapi, UID, rawId, [
      'id',
      'documentId',
      'notificationId',
      'targetEmail',
      'targetProfileId',
      'ownerProfileId',
      'receiverEmail',
      'receiverProfileId',
      'recipientEmail',
      'recipientProfileId',
      'broadcast',
      'isBroadcast',
      'targetAll',
    ]);

    if (!entity) {
      entity = await strapi.db.query(UID).findOne({
        where: { notificationId: rawId },
        select: [
          'id',
          'documentId',
          'notificationId',
          'targetEmail',
          'targetProfileId',
          'ownerProfileId',
          'receiverEmail',
          'receiverProfileId',
          'recipientEmail',
          'recipientProfileId',
          'broadcast',
          'isBroadcast',
          'targetAll',
        ],
      } as any);
    }
    if (!entity) return ctx.notFound('Bildirim bulunamadi.');

    const isBroadcast =
      Boolean(entity.broadcast) || Boolean(entity.isBroadcast) || Boolean(entity.targetAll);
    const isOwner = matchesIdentity(
      entity,
      identity,
      ['targetEmail', 'receiverEmail', 'recipientEmail'],
      ['targetProfileId', 'ownerProfileId', 'receiverProfileId', 'recipientProfileId'],
    );
    if (!isBroadcast && !isOwner) {
      return ctx.forbidden('Bu bildirimi guncelleyemezsiniz.');
    }

    const readAt =
      String((ctx.request?.body || {}).readAt || '').trim() || new Date().toISOString();
    const updated = await strapi.entityService.update(UID as any, entity.id as any, {
      data: {
        isRead: true,
        readAt,
        updatedAtClient: readAt,
      },
    });

    ctx.body = { data: { ok: true, notificationId: rawId, readAt, notification: updated } };
  },
}));
