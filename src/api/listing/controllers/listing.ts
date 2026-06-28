/**
 * listing controller
 */

import { factories } from '@strapi/strapi';
import { normalizeEmail, ownerIdFromEmail, readIdentity } from '../../../utils/identity';

const LISTING_UID = 'api::listing.listing';
const PROFILE_UID = 'api::profile-setting.profile-setting';

const clean = (value: unknown): string => String(value ?? '').trim();

const parseObject = (value: unknown): Record<string, unknown> | null => {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch (_) {
    return null;
  }
};

const hasActivePremiumExpiry = (
  profile: Record<string, unknown> | null,
): boolean => {
  if (!profile) return false;
  const premium = parseObject(
    profile.activePremium ?? profile.activePremiumSubscription,
  );
  if (!premium) return false;

  const raw = clean(premium.endsAt ?? premium.endDate ?? premium.expiresAt);
  if (!raw) return false;
  const endsAt = new Date(raw);
  return !Number.isNaN(endsAt.getTime()) && endsAt.getTime() > Date.now();
};

const findProfileForIdentity = async (
  strapi: any,
  email: string,
  ownerId: string,
) => {
  const rows = await strapi.entityService.findMany(PROFILE_UID as any, {
    filters: {
      $or: [{ profileId: ownerId }, { ownerEmail: email }],
    },
    fields: [
      'profileId',
      'ownerEmail',
      'activePremium',
      'activePremiumSubscription',
    ],
    limit: 1,
  } as any);
  return (Array.isArray(rows) ? rows[0] : rows) as
    | Record<string, unknown>
    | null;
};

export default factories.createCoreController(
  LISTING_UID,
  ({ strapi }) => ({
    async create(ctx) {
      const identity = readIdentity(ctx);
      if (!identity) return ctx.unauthorized('Oturum gerekli.');

      const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
      const input = (body.data ?? body) as Record<string, unknown>;
      const profile = await findProfileForIdentity(
        strapi,
        identity.email,
        identity.ownerId,
      );

      const ownerProfileId =
        clean(profile?.profileId) ||
        identity.ownerId ||
        ownerIdFromEmail(identity.email);
      const isPremium = hasActivePremiumExpiry(profile);
      const publishedAt = new Date().toISOString();

      ctx.request.body = {
        data: {
          ...input,
          ownerProfileId,
          ownerId: ownerProfileId,
          ownerEmail: normalizeEmail(identity.email),
          isPremium,
          isPremiumOwner: isPremium,
          status: 'active',
          publishedAt,
        },
      };
      ctx.query = {
        ...(ctx.query ?? {}),
        status: 'published',
      };

      return super.create(ctx);
    },
  }),
);
