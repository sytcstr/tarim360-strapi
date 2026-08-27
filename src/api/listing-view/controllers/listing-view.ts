import { factories } from '@strapi/strapi';
import { registerView } from '../../engagement/services/engagement-view-service';
import { loadEntityByRouteId, matchesIdentity, readIdentity } from '../../../utils/identity';

const UID = 'api::listing-view.listing-view';
const LISTING_UID = 'api::listing.listing';

const asString = (value: unknown): string => String(value ?? '').trim();

/**
 * Aşama 10 (legacy delegation): the counter-increment side of this route
 * now goes through the same engagement-view dedup/atomic-increment core
 * (registerView) used by POST /engagements/view, instead of its own
 * unconditional current+1 update. This is the fix for the "no dedup, any
 * request increments" finding from the earlier backend audit, and it
 * also means a view recorded via this legacy route and one recorded via
 * the new route share the SAME 24h-dedup record — no double counting
 * regardless of which URL a given Flutter build calls. The raw
 * listing-view event row is still created unchanged, for anything that
 * still expects an event log.
 */
export default factories.createCoreController(UID as any, ({ strapi }) => ({
  async create(ctx) {
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const data = (body.data && typeof body.data === 'object' ? body.data : body) as Record<
      string,
      unknown
    >;
    const listingId = asString(data.listingId);
    if (!listingId) return ctx.badRequest('listingId zorunlu.');
    const viewedAt = asString(data.viewedAt) || new Date().toISOString();

    const entity = await strapi.entityService.create(UID as any, {
      data: {
        ...data,
        listingId,
        viewedAt,
      },
    });

    try {
      // LISTING_L9_OWNER_BUYER_ACTION_POLICY_REPORT.md L9.9: same
      // self-view exclusion as POST /engagements/view (engagement-v1.ts),
      // applied here too since this legacy route independently calls
      // registerView and would otherwise let an owner inflate their own
      // listing's view count through this path even after that fix.
      // Uses the JWT-derived identity (readIdentity), never the
      // client-supplied `data.email`/`data.ownerId` fields below, which
      // remain only for actor-key/dedup purposes on genuine (non-self)
      // views.
      const identity = readIdentity(ctx);
      const isSelfView =
        !!identity &&
        matchesIdentity(
          await loadEntityByRouteId(strapi, LISTING_UID, listingId, [
            'ownerEmail',
            'ownerProfileId',
            'ownerId',
          ]),
          identity,
          ['ownerEmail'],
          ['ownerProfileId', 'ownerId'],
        );
      if (!isSelfView) {
        const email = asString(data.email).toLowerCase();
        const ownerId = asString(data.ownerId);
        const jwtEmail = (ctx?.state?.user?.email ?? '').toString().trim().toLowerCase();
        const actorKey = jwtEmail
          ? `user:${jwtEmail}`
          : email
            ? `user:${email}`
            : ownerId
              ? `owner:${ownerId}`
              : `ip:${ctx.request?.ip ?? ctx.ip ?? 'unknown'}`;
        await registerView(strapi, actorKey, 'listing', listingId);
      }
    } catch (e) {
      strapi.log.warn(`Listing view counter update failed: ${String(e)}`);
    }

    ctx.body = { data: entity };
  },
}));
