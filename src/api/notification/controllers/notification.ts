import { factories } from '@strapi/strapi';
import {
  loadEntityByRouteId,
  matchesIdentity,
  readIdentity,
  resolveListingOwnerByAnyId,
  resolveLogisticsLoadOwnerByAnyId,
  resolveProcessedProductOwnerByAnyId,
  resolveProfileOwnerIfExists,
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
 * which ids exist. farmer_question is intentionally NOT included here:
 * hub-content (the content-type farmer questions are actually stored on)
 * has no verifiable author-identity field today (only a display-name
 * string), so that domain is left on the now self-target-only generic
 * endpoint until a real field exists -- see the report's disclosed gaps.
 */
const DOMAIN_EVENTS: Record<
  string,
  { events: Record<string, { kind: string; title: string; message: string }> }
> = {
  listing: {
    events: {
      favorite: { kind: 'favorite', title: 'Ilanin Favorilendi', message: 'ilanini favorilerine ekledi.' },
      like: { kind: 'like', title: 'Ilanin Begenildi', message: 'ilanini begendi.' },
    },
  },
  logistics_load: {
    events: {
      favorite: { kind: 'favorite', title: 'Yuk Ilanin Favorilendi', message: 'yuk ilanini favorilerine ekledi.' },
      like: { kind: 'like', title: 'Yuk Ilanin Begenildi', message: 'yuk ilanini begendi.' },
    },
  },
  processed_product: {
    events: {
      favorite: { kind: 'favorite', title: 'Urunun Favorilendi', message: 'urununu favorilerine ekledi.' },
      like: { kind: 'like', title: 'Urunun Begenildi', message: 'urununu begendi.' },
    },
  },
  profile: {
    events: {
      favorite: { kind: 'favorite', title: 'Profilin Favorilendi', message: 'profilini favorilerine ekledi.' },
      comment: { kind: 'comment', title: 'Profiline Yeni Yorum', message: 'profiline yorum yapti.' },
    },
  },
};

const resolveDomainOwner = async (
  strapi: any,
  domain: string,
  entityId: string,
): Promise<{ email: string; ownerId: string } | null> => {
  switch (domain) {
    case 'listing':
      return resolveListingOwnerByAnyId(strapi, entityId);
    case 'logistics_load':
      return resolveLogisticsLoadOwnerByAnyId(strapi, entityId);
    case 'processed_product':
      return resolveProcessedProductOwnerByAnyId(strapi, entityId);
    case 'profile':
      return resolveProfileOwnerIfExists(strapi, entityId);
    default:
      return null;
  }
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

    const owner = await resolveDomainOwner(strapi, domain, entityId);
    if (!owner || (!owner.email && !owner.ownerId)) {
      return ctx.notFound('Hedef kayit bulunamadi.');
    }
    if (owner.email === identity.email || owner.ownerId === identity.ownerId) {
      // Self-interaction (e.g. favoriting your own listing) never
      // notifies -- matches every client-side guard this replaces.
      ctx.body = { data: { ok: true, skipped: 'self' } };
      return;
    }

    const senderLabel = identity.email.split('@')[0] || 'Bir kullanici';
    const notifData: Record<string, unknown> = {
      notificationId: `${domain}_${event}_${entityId}_${identity.ownerId}`,
      kind: eventConfig.kind,
      event,
      source: domain,
      title: eventConfig.title,
      message: `${senderLabel} ${eventConfig.message}`,
      isRead: false,
      senderEmail: identity.email,
      senderProfileId: identity.ownerId,
      createdAtClient: new Date().toISOString(),
    };
    if (owner.email) notifData.targetEmail = owner.email;
    if (owner.ownerId) notifData.targetProfileId = owner.ownerId;

    try {
      await strapi.entityService.create(UID as any, { data: notifData });
    } catch (e) {
      // Deterministic notificationId (domain+event+entityId+sender) means
      // a genuine repeat of the same interaction by the same sender hits
      // the unique constraint here instead of creating a duplicate row --
      // expected, not an error.
      strapi.log.warn(`Domain-event notification skipped: ${String(e)}`);
    }

    ctx.body = { data: { ok: true } };
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
