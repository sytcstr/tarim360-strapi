/**
 * listing-comment controller
 */

import { factories } from '@strapi/strapi';
import {
  loadEntityByRouteId,
  matchesIdentity,
  readIdentity,
} from '../../../utils/identity';
import { recountListingComments } from '../../../utils/listing-metrics';
import {
  fingerprintPayload,
  isValidOperationId,
  resolveOperation,
} from '../../../utils/operation-idempotency';
import { sendEngagementError } from '../../../utils/engagement-contract';

const UID = 'api::listing-comment.listing-comment';

const asString = (value: unknown): string => String(value ?? '').trim();
const dataBody = (ctx: any): Record<string, unknown> => {
  const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
  return (body.data && typeof body.data === 'object' ? body.data : body) as Record<
    string,
    unknown
  >;
};

export default factories.createCoreController(UID as any, ({ strapi }) => ({
  async create(ctx) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

    const body = dataBody(ctx);
    const listingId = asString(body.listingId);
    const text = asString(body.body ?? body.comment ?? body.text);
    const operationId = asString(body.operationId);
    if (!listingId) return ctx.badRequest('listingId zorunlu.');
    if (!text) return ctx.badRequest('Yorum bos olamaz.');
    if (!isValidOperationId(operationId)) {
      return ctx.badRequest('operationId zorunlu ve UUID formatinda olmali.');
    }

    const fingerprint = fingerprintPayload({ listingId, text, ownerId: identity.ownerId });
    const resolution = await resolveOperation(strapi, UID, operationId, fingerprint);
    if (resolution.status === 'conflict') {
      return sendEngagementError(
        ctx,
        'CONFLICT',
        'Bu operationId farkli bir istekle daha once kullanilmis.',
      );
    }
    if (resolution.status === 'duplicate') {
      const sanitized = await this.sanitizeOutput(resolution.existing, ctx);
      ctx.status = 200;
      ctx.body = this.transformResponse(sanitized);
      return;
    }

    const nowIso = new Date().toISOString();
    let entity;
    try {
      entity = await strapi.entityService.create(UID as any, {
        data: {
          listingId,
          body: text,
          ownerId: identity.ownerId,
          ownerEmail: identity.email,
          createdAtClient: asString(body.createdAtClient) || nowIso,
          isDeleted: false,
          operationId,
          payloadFingerprint: fingerprint,
        },
      });
    } catch (e) {
      // Concurrent request already inserted the same operationId first —
      // re-resolve and return the winner's row idempotently.
      const retry = await resolveOperation(strapi, UID, operationId, fingerprint);
      if (retry.status === 'duplicate') {
        const sanitized = await this.sanitizeOutput(retry.existing, ctx);
        ctx.status = 200;
        ctx.body = this.transformResponse(sanitized);
        return;
      }
      throw e;
    }
    await recountListingComments(strapi, listingId);

    const sanitized = await this.sanitizeOutput(entity, ctx);
    ctx.status = 201;
    ctx.body = this.transformResponse(sanitized);
  },

  async delete(ctx) {
    const identity = readIdentity(ctx);
    if (!identity) return ctx.unauthorized('Kimlik dogrulanamadi.');

    const rawId = asString(ctx.params.id ?? ctx.params.documentId);
    if (!rawId) return ctx.badRequest('Yorum id zorunlu.');
    const entity = await loadEntityByRouteId(strapi, UID, rawId, [
      'id',
      'documentId',
      'listingId',
      'ownerId',
      'ownerEmail',
      'isDeleted',
    ]);
    if (!entity) return ctx.notFound('Yorum bulunamadi.');
    if (!matchesIdentity(entity, identity, ['ownerEmail'], ['ownerId'])) {
      return ctx.forbidden('Bu yorumu silme yetkiniz yok.');
    }

    await strapi.entityService.update(UID as any, entity.id as any, {
      data: { isDeleted: true } as any,
    });
    const count = await recountListingComments(strapi, entity.listingId);
    ctx.body = {
      data: {
        ok: true,
        id: rawId,
        listingId: entity.listingId,
        commentCount: count,
      },
    };
  },
}));
