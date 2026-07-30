/**
 * listing-share controller
 */

import { factories } from '@strapi/strapi';
import { readIdentity } from '../../../utils/identity';
import { recountListingShares } from '../../../utils/listing-metrics';
import {
  fingerprintPayload,
  isValidOperationId,
  resolveOperation,
} from '../../../utils/operation-idempotency';
import { sendEngagementError } from '../../../utils/engagement-contract';

const UID = 'api::listing-share.listing-share';

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
    // ENGAGEMENT_API_CONTRACT.md §4.5: auth is now required (previously
    // optional) — an unauthenticated caller could otherwise spam real,
    // publicly-visible shareCount inflation with zero friction.
    const identity = readIdentity(ctx);
    if (!identity) return sendEngagementError(ctx, 'UNAUTHORIZED', 'Kimlik dogrulanamadi.');

    const body = dataBody(ctx);
    const listingId = asString(body.listingId);
    const channel = asString(body.channel) || 'system_share';
    const operationId = asString(body.operationId);
    if (!listingId) return ctx.badRequest('listingId zorunlu.');
    if (!isValidOperationId(operationId)) {
      return ctx.badRequest('operationId zorunlu ve UUID formatinda olmali.');
    }

    // §4.5: "share" measures the share FLOW being started, not a
    // confirmed completed share — see the contract for why this
    // distinction matters and must stay honest in any future UI copy.
    const fingerprint = fingerprintPayload({ listingId, channel, ownerId: identity.ownerId });
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
      const response = this.transformResponse(sanitized) as any;
      ctx.status = 200;
      ctx.body = {
        data: response.data,
        meta: { ...(response.meta ?? {}), shareCount: await recountListingShares(strapi, listingId) },
      };
      return;
    }

    const nowIso = new Date().toISOString();
    let entity;
    try {
      entity = await strapi.entityService.create(UID as any, {
        data: {
          listingId,
          ownerId: identity.ownerId,
          ownerEmail: identity.email,
          channel,
          sharedAt: asString(body.sharedAt) || nowIso,
          createdAtClient: asString(body.createdAtClient) || nowIso,
          metadata:
            body.metadata && typeof body.metadata === 'object'
              ? body.metadata
              : undefined,
          operationId,
          payloadFingerprint: fingerprint,
        },
      });
    } catch (e) {
      const retry = await resolveOperation(strapi, UID, operationId, fingerprint);
      if (retry.status === 'duplicate') {
        const sanitized = await this.sanitizeOutput(retry.existing, ctx);
        const response = this.transformResponse(sanitized) as any;
        ctx.status = 200;
        ctx.body = {
          data: response.data,
          meta: { ...(response.meta ?? {}), shareCount: await recountListingShares(strapi, listingId) },
        };
        return;
      }
      throw e;
    }
    const shareCount = await recountListingShares(strapi, listingId);

    const sanitized = await this.sanitizeOutput(entity, ctx);
    const response = this.transformResponse(sanitized) as any;
    ctx.status = 201;
    ctx.body = {
      data: response.data,
      meta: { ...(response.meta ?? {}), shareCount },
    };
  },
}));
