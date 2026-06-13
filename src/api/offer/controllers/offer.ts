/**
 * offer controller
 */

import { factories } from '@strapi/strapi';
import {
  loadEntityByRouteId,
  matchesIdentity,
  normalizeEmail,
  ownerIdFromEmail,
  readIdentity,
  resolveListingOwnerByAnyId,
} from '../../../utils/identity';

const UID = 'api::offer.offer';
const createLocks = new Map<string, Promise<void>>();

const findByOfferId = async (strapi: any, offerId: string) =>
  strapi.db.query(UID).findOne({
    where: { offerId },
  } as any);

export default factories.createCoreController(UID, ({ strapi }) => ({
  async create(ctx) {
    const identity = readIdentity(ctx);
    if (!identity) {
      return ctx.unauthorized('Kimlik dogrulanamadi.');
    }

    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const payloadRaw = (body.data ?? body) as Record<string, unknown>;
    const data: Record<string, unknown> = { ...payloadRaw };
    const headerKey = String(
      ctx.request?.headers?.['idempotency-key'] ?? '',
    ).trim();
    const offerId = String(data.offerId ?? headerKey).trim();

    if (!offerId) {
      return ctx.badRequest('offerId zorunludur.');
    }

    const respondWithExisting = async (
      entity: Record<string, unknown>,
    ) => {
      if (
        !matchesIdentity(
          entity,
          identity,
          ['requesterEmail', 'receiverEmail'],
          ['requesterProfileId', 'receiverProfileId'],
        )
      ) {
        return ctx.conflict('Bu offerId baska bir teklifte kullaniliyor.');
      }
      const sanitized = await this.sanitizeOutput(entity, ctx);
      ctx.status = 200;
      ctx.body = this.transformResponse(sanitized, { idempotent: true });
    };

    const existing = await findByOfferId(strapi, offerId);
    if (existing) return respondWithExisting(existing);

    const activeCreate = createLocks.get(offerId);
    if (activeCreate) {
      await activeCreate;
      const created = await findByOfferId(strapi, offerId);
      if (!created) {
        return ctx.internalServerError('Teklif kaydi dogrulanamadi.');
      }
      return respondWithExisting(created);
    }

    const creation = (async () => {
      const listingOwner = await resolveListingOwnerByAnyId(
        strapi,
        data.listingId ?? data.listingNo,
      );

      const requesterEmail = identity.email;
      const requesterProfileId = identity.ownerId;

      let receiverEmail = normalizeEmail(data.receiverEmail);
      let receiverProfileId = String(data.receiverProfileId ?? '').trim();

      if (!receiverEmail && listingOwner?.email) {
        receiverEmail = listingOwner.email;
      }
      if (!receiverProfileId && listingOwner?.ownerId) {
        receiverProfileId = listingOwner.ownerId;
      }
      if (!receiverProfileId && receiverEmail) {
        receiverProfileId = ownerIdFromEmail(receiverEmail);
      }

      if (!receiverEmail && !receiverProfileId) {
        return ctx.badRequest(
          'Teklif alicisi bulunamadi. Ilan sahibi bilgisi eksik.',
        );
      }
      if (
        (receiverEmail && receiverEmail === requesterEmail) ||
        (receiverProfileId && receiverProfileId === requesterProfileId)
      ) {
        return ctx.badRequest('Kendi ilaniniza teklif veremezsiniz.');
      }

      const nowIso = new Date().toISOString();
      data.offerId = offerId;
      data.requesterEmail = requesterEmail;
      data.requesterProfileId = requesterProfileId;
      data.receiverEmail = receiverEmail;
      data.receiverProfileId = receiverProfileId;
      data.direction = String(data.direction ?? '').trim() || 'outgoing';
      data.offerStatus = String(data.offerStatus ?? '').trim() || 'pending';
      data.createdAtClient =
        String(data.createdAtClient ?? '').trim() || nowIso;

      const sanitizedInput = await this.sanitizeInput(data, ctx);
      const entity = await strapi.entityService.create(UID as any, {
        data: sanitizedInput,
      });

      try {
        const notifData: Record<string, unknown> = {
          notificationId: `offer_${Date.now()}`,
          kind: 'offer',
          title: 'Yeni Teklif',
          message: `${String(data.title ?? 'Ilan')} icin yeni teklif aldiniz.`,
          isRead: false,
          createdAtClient: nowIso,
        };
        if (receiverEmail) notifData.targetEmail = receiverEmail;
        if (receiverProfileId) {
          notifData.targetProfileId = receiverProfileId;
        }
        await strapi.entityService.create(
          'api::notification.notification' as any,
          { data: notifData },
        );
      } catch (e) {
        strapi.log.warn(`Offer notification create failed: ${String(e)}`);
      }

      return entity;
    })();

    const completion = creation.then(
      () => undefined,
      () => undefined,
    );
    createLocks.set(offerId, completion);

    try {
      const entity = await creation;
      if (!entity) return;
      const sanitizedOutput = await this.sanitizeOutput(entity, ctx);
      ctx.status = 201;
      ctx.body = this.transformResponse(sanitizedOutput);
    } catch (error) {
      const createdByConcurrentRequest = await findByOfferId(strapi, offerId);
      if (!createdByConcurrentRequest) throw error;
      return respondWithExisting(createdByConcurrentRequest);
    } finally {
      if (createLocks.get(offerId) === completion) {
        createLocks.delete(offerId);
      }
    }
  },

  async markSeen(ctx) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

    const rawId = String(ctx.params.offerId || '').trim();
    if (!rawId) return ctx.badRequest('offerId zorunlu.');

    let entity = await loadEntityByRouteId(strapi, UID, rawId, [
      'id',
      'documentId',
      'offerId',
      'requesterEmail',
      'requesterProfileId',
      'receiverEmail',
      'receiverProfileId',
      'seenBy',
    ]);
    if (!entity) {
      entity = await strapi.db.query(UID).findOne({
        where: { offerId: rawId },
        select: [
          'id',
          'documentId',
          'offerId',
          'requesterEmail',
          'requesterProfileId',
          'receiverEmail',
          'receiverProfileId',
          'seenBy',
        ],
      } as any);
    }
    if (!entity) return ctx.notFound('Teklif bulunamadi.');

    const isParticipant = matchesIdentity(
      entity,
      identity,
      ['requesterEmail', 'receiverEmail'],
      ['requesterProfileId', 'receiverProfileId'],
    );
    if (!isParticipant) return ctx.forbidden('Bu teklife erisim yok.');

    const seenAt =
      String((ctx.request?.body || {}).seenAt || '').trim() ||
      new Date().toISOString();
    const seenBy =
      entity.seenBy && typeof entity.seenBy === 'object'
        ? { ...entity.seenBy }
        : {};
    seenBy[identity.ownerId || identity.email] = seenAt;

    const updated = await strapi.entityService.update(
      UID as any,
      entity.id as any,
      {
        data: {
          seenAt,
          seenBy,
          updatedAtClient: seenAt,
        },
      },
    );

    ctx.body = { data: { ok: true, offerId: rawId, seenAt, offer: updated } };
  },
}));
