import type { Core } from '@strapi/strapi';

export type SessionIdentity = {
  email: string;
  ownerId: string;
};

export const normalizeEmail = (value: unknown): string =>
  String(value ?? '').trim().toLowerCase();

export const ownerIdFromEmail = (email: string): string => {
  const safe = normalizeEmail(email).replace(/[^a-z0-9]/g, '_');
  return safe ? `u_${safe}` : '';
};

export const readIdentity = (ctx: any): SessionIdentity | null => {
  const email = normalizeEmail(ctx?.state?.user?.email);
  if (!email) return null;
  const ownerId = ownerIdFromEmail(email);
  if (!ownerId) return null;
  return { email, ownerId };
};

export const denyNoIdentity = (ctx: any): false => {
  ctx.unauthorized('Kimlik dogrulanamadi.');
  return false;
};

export const mergeScopeOrFilter = (ctx: any, orClauses: object[]) => {
  const query = (ctx.query ?? {}) as Record<string, unknown>;
  const filters = (query.filters ?? {}) as Record<string, unknown>;
  const nextOr = Array.isArray(filters.$or) ? [...filters.$or, ...orClauses] : [...orClauses];
  ctx.query = {
    ...query,
    filters: {
      ...filters,
      $or: nextOr,
    },
  };
};

export const matchesIdentity = (
  entity: Record<string, unknown> | null | undefined,
  identity: SessionIdentity,
  emailFields: string[],
  profileFields: string[],
): boolean => {
  if (!entity) return false;
  const emailHit = emailFields.some((f) => normalizeEmail(entity[f]) === identity.email);
  const profileHit = profileFields.some((f) => String(entity[f] ?? '').trim() === identity.ownerId);
  return emailHit || profileHit;
};

export const loadEntityByRouteId = async (
  strapi: Core.Strapi,
  uid: string,
  rawId: string,
  fields: string[],
): Promise<Record<string, unknown> | null> => {
  const id = String(rawId ?? '').trim();
  if (!id) return null;

  try {
    const viaEntity = await strapi.entityService.findOne(uid as any, id as any, { fields });
    if (viaEntity && typeof viaEntity === 'object') {
      return viaEntity as Record<string, unknown>;
    }
  } catch (_) {
    // continue
  }

  const maybeNumeric = Number(id);
  if (Number.isInteger(maybeNumeric) && maybeNumeric > 0) {
    try {
      const viaNumeric = await strapi.entityService.findOne(uid as any, maybeNumeric as any, { fields });
      if (viaNumeric && typeof viaNumeric === 'object') {
        return viaNumeric as Record<string, unknown>;
      }
    } catch (_) {
      // continue
    }
  }

  return null;
};
