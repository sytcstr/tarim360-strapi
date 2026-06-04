import { factories } from '@strapi/strapi';
import {
  loadEntityByRouteId,
  matchesIdentity,
  readIdentity,
} from '../../../utils/identity';

const UID = 'api::notification.notification';

export default factories.createCoreController(UID, ({ strapi }) => ({
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
