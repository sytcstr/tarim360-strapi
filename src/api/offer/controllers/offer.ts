/**
 * offer controller
 */

import { factories } from '@strapi/strapi';
import {
  matchesIdentity,
  normalizeEmail,
  ownerIdFromEmail,
  readIdentity,
  resolveListingOwnerByAnyId,
} from '../../../utils/identity';
import { recountListingOffers } from '../../../utils/listing-metrics';

const UID = 'api::offer.offer';
const createLocks = new Map<string, Promise<void>>();

const findByOfferId = async (strapi: any, offerId: string) =>
  strapi.db.query(UID).findOne({
    where: { offerId },
  } as any);

const offerIdCandidates = (raw: unknown): string[] => {
  const value = String(raw ?? '').trim();
  if (!value) return [];
  const candidates = new Set<string>([value]);
  if (value.startsWith('offer_')) {
    const stripped = value.substring('offer_'.length).trim();
    if (stripped) candidates.add(stripped);
  } else {
    candidates.add(`offer_${value}`);
  }
  return [...candidates];
};

const findByAnyOfferId = async (strapi: any, raw: unknown) => {
  for (const candidate of offerIdCandidates(raw)) {
    const entity = await findByOfferId(strapi, candidate);
    if (entity) return entity;
  }
  return null;
};

const participantRole = (
  entity: Record<string, unknown>,
  identity: { email: string; ownerId: string },
) => ({
  requester: matchesIdentity(
    entity,
    identity,
    ['requesterEmail'],
    ['requesterProfileId'],
  ),
  receiver: matchesIdentity(
    entity,
    identity,
    ['receiverEmail'],
    ['receiverProfileId'],
  ),
});

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

      // O1 (OFFER_O1_CORE_FIX_REPORT.md / BUG-OFFER-001): the resolved
      // listing owner is now always authoritative over client-supplied
      // receiver fields, not just a fallback used when both are empty.
      // Previously, a client sending BOTH receiverEmail and
      // receiverProfileId bypassed listing-owner resolution entirely --
      // confirmed live: an attacker could create a 201 offer targeting
      // an arbitrary victim on a listing that didn't even need to exist,
      // since only the requester identity was ever verified. Client
      // values are now only a fallback for the case listingOwner
      // resolution itself fails (unknown/legacy listingId) -- same
      // "server wins, client is a hint at best" posture as M1's message
      // sender-identity fix.
      let receiverEmail = listingOwner?.email || normalizeEmail(data.receiverEmail);
      let receiverProfileId =
        listingOwner?.ownerId || String(data.receiverProfileId ?? '').trim();
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
        await recountListingOffers(strapi, data.listingId ?? data.listingNo);
      } catch (e) {
        strapi.log.warn(`Offer counter update failed: ${String(e)}`);
      }

      try {
        // NOTIFICATION_N1_SECURITY_FIX_REPORT.md BUG-NOTIF-003: deterministic
        // per-offer notificationId (not Date.now()) so a create-lock retry
        // for the same offerId (see respondWithExisting above) hits the
        // notification schema's unique constraint instead of creating a
        // second "Yeni Teklif" row/push. Flutter no longer creates its own
        // duplicate offer-created notification -- this is now the only one.
        const notifData: Record<string, unknown> = {
          notificationId: `offer_created_${offerId}`,
          kind: 'offer',
          event: 'created',
          source: 'offer',
          offerId,
          listingId: String(data.listingId ?? data.listingNo ?? ''),
          title: 'Yeni Teklif',
          message: `${String(data.title ?? 'İlan')} için yeni teklif aldınız.`,
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

    const entity = await findByAnyOfferId(strapi, rawId);
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

  async updateByOfferId(ctx) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

    const rawId = String(ctx.params.offerId || '').trim();
    if (!rawId) return ctx.badRequest('offerId zorunlu.');
    const entity = await findByAnyOfferId(strapi, rawId);
    if (!entity) return ctx.notFound('Teklif bulunamadi.');

    const role = participantRole(entity, identity);
    if (!role.requester && !role.receiver) {
      return ctx.forbidden('Bu teklifi guncelleme yetkiniz yok.');
    }

    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const payload = (body.data ?? body) as Record<string, unknown>;
    const status = String(payload.offerStatus ?? '').trim().toLowerCase();
    const allowedStatuses = new Set([
      'pending',
      'accepted',
      'rejected',
      'bargaining',
    ]);
    if (status && !allowedStatuses.has(status)) {
      return ctx.badRequest('Teklif durumu gecersiz.');
    }
    if ((status === 'accepted' || status === 'rejected') && !role.receiver) {
      return ctx.forbidden('Teklifi yalnizca ilan sahibi kabul veya reddedebilir.');
    }

    const updateData: Record<string, unknown> = {
      updatedAtClient:
        String(payload.updatedAtClient ?? '').trim() ||
        new Date().toISOString(),
    };
    if (status) updateData.offerStatus = status;
    if (Object.prototype.hasOwnProperty.call(payload, 'approved')) {
      updateData.approved = payload.approved === true;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'priceText')) {
      updateData.priceText = String(payload.priceText ?? '').trim();
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'note')) {
      updateData.note = String(payload.note ?? '').trim();
    }

    const updated = await strapi.entityService.update(
      UID as any,
      entity.id as any,
      { data: updateData },
    );

    // NOTIFICATION_N1_SECURITY_FIX_REPORT.md BUG-NOTIF-003: this is now the
    // sole, server-authoritative source of accept/reject/counter
    // notifications -- the recipient is always derived from THIS offer
    // row's own requester/receiver fields (never client input), and is
    // always "whichever participant did NOT make this call" (the caller
    // is never notified about their own action). notificationId is
    // deterministic per (offerId,status) so a retry of the same status
    // update hits the notification schema's unique constraint on
    // notificationId and is silently absorbed -- exactly one notification
    // per real status change, not one per HTTP attempt.
    if (status && status !== 'pending') {
      try {
        const recipientEmail = role.requester
          ? normalizeEmail(entity.receiverEmail)
          : normalizeEmail(entity.requesterEmail);
        const recipientProfileId = role.requester
          ? String(entity.receiverProfileId ?? '').trim()
          : String(entity.requesterProfileId ?? '').trim();
        if (recipientEmail || recipientProfileId) {
          const titleByStatus: Record<string, string> = {
            accepted: 'Teklif Kabul Edildi',
            rejected: 'Teklif Reddedildi',
            bargaining: 'Karşı Teklif',
          };
          const offerTitle = String(entity.title ?? 'İlan').trim() || 'İlan';
          const notifData: Record<string, unknown> = {
            notificationId: `offer_${status}_${entity.offerId}`,
            kind: 'offer',
            event: status,
            source: 'offer',
            offerId: String(entity.offerId ?? ''),
            listingId: String(entity.listingId ?? ''),
            title: titleByStatus[status] ?? 'Teklif Güncellendi',
            message: `${offerTitle} teklifi güncellendi.`,
            isRead: false,
            createdAtClient: String(updateData.updatedAtClient ?? ''),
          };
          if (recipientEmail) notifData.targetEmail = recipientEmail;
          if (recipientProfileId) notifData.targetProfileId = recipientProfileId;
          await strapi.entityService.create(
            'api::notification.notification' as any,
            { data: notifData },
          );
        }
      } catch (e) {
        // Either a genuine failure (logged, non-fatal to the offer update
        // itself) or a duplicate-status-update retry hitting the
        // notificationId unique constraint (expected, not an error).
        strapi.log.warn(`Offer status notification skipped: ${String(e)}`);
      }
    }

    ctx.body = { data: updated };
  },

  async deleteByOfferId(ctx) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

    const rawId = String(ctx.params.offerId || '').trim();
    if (!rawId) return ctx.badRequest('offerId zorunlu.');
    const entity = await findByAnyOfferId(strapi, rawId);
    if (!entity) return ctx.notFound('Teklif bulunamadi.');

    const role = participantRole(entity, identity);
    if (!role.requester && !role.receiver) {
      return ctx.forbidden('Bu teklifi silme yetkiniz yok.');
    }

    const listingId = entity.listingId;
    await strapi.entityService.delete(UID as any, entity.id as any);
    try {
      await recountListingOffers(strapi, listingId);
    } catch (e) {
      strapi.log.warn(`Offer counter recount failed: ${String(e)}`);
    }
    ctx.body = {
      data: {
        ok: true,
        offerId: String(entity.offerId ?? rawId),
      },
    };
  },
}));
