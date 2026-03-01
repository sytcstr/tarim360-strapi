/**
 * offer controller
 */

import { factories } from '@strapi/strapi';
import { normalizeEmail, ownerIdFromEmail, readIdentity, resolveListingOwnerByAnyId } from '../../../utils/identity';

const UID = 'api::offer.offer';

export default factories.createCoreController(UID, ({ strapi }) => ({
  async create(ctx) {
    const identity = readIdentity(ctx);
    if (!identity) {
      return ctx.unauthorized('Kimlik dogrulanamadi.');
    }

    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const payloadRaw = (body.data ?? body) as Record<string, unknown>;
    const data: Record<string, unknown> = { ...payloadRaw };

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
      return ctx.badRequest('Teklif alicisi bulunamadi. Ilan sahibi bilgisi eksik.');
    }
    if (
      (receiverEmail && receiverEmail === requesterEmail) ||
      (receiverProfileId && receiverProfileId === requesterProfileId)
    ) {
      return ctx.badRequest('Kendi ilaniniza teklif veremezsiniz.');
    }

    const nowIso = new Date().toISOString();
    data.requesterEmail = requesterEmail;
    data.requesterProfileId = requesterProfileId;
    data.receiverEmail = receiverEmail;
    data.receiverProfileId = receiverProfileId;
    data.direction = String(data.direction ?? '').trim() || 'outgoing';
    data.offerStatus = String(data.offerStatus ?? '').trim() || 'pending';
    data.createdAtClient = String(data.createdAtClient ?? '').trim() || nowIso;
    data.offerId = String(data.offerId ?? '').trim() || `${Date.now()}`;

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
      if (receiverProfileId) notifData.targetProfileId = receiverProfileId;
      await strapi.entityService.create('api::notification.notification' as any, {
        data: notifData,
      });
    } catch (e) {
      strapi.log.warn(`Offer notification create failed: ${String(e)}`);
    }

    const sanitizedOutput = await this.sanitizeOutput(entity, ctx);
    return this.transformResponse(sanitizedOutput);
  },
}));
