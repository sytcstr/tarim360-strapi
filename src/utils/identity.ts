import type { Core } from '@strapi/strapi';

export type SessionIdentity = {
  email: string;
  ownerId: string;
};

export type ListingOwnerIdentity = {
  email: string;
  ownerId: string;
};

export type ThreadParticipants = {
  requesterEmail: string;
  requesterProfileId: string;
  receiverEmail: string;
  receiverProfileId: string;
};

export const normalizeEmail = (value: unknown): string =>
  String(value ?? '').trim().toLowerCase();

export const ownerIdFromEmail = (email: string): string => {
  const safe = normalizeEmail(email).replace(/[^a-z0-9]/g, '_');
  return safe ? `u_${safe}` : '';
};

const normalizeOwnerId = (value: unknown): string =>
  String(value ?? '').trim();

const idCandidates = (raw: unknown): string[] => {
  const id = String(raw ?? '').trim();
  if (!id) return [];
  const set = new Set<string>([id]);
  for (const prefix of ['strapi_', 'listing_', 'offer_', 'thread_']) {
    if (id.startsWith(prefix)) {
      const trimmed = id.slice(prefix.length).trim();
      if (trimmed) set.add(trimmed);
    }
  }
  const digit = id.match(/(\d+)/)?.[1];
  if (digit) set.add(digit);
  return [...set];
};

export const resolveListingOwnerByAnyId = async (
  strapi: Core.Strapi,
  rawListingId: unknown,
): Promise<ListingOwnerIdentity | null> => {
  const candidates = idCandidates(rawListingId);
  if (candidates.length === 0) return null;

  for (const candidate of candidates) {
    try {
      const entity = await strapi.entityService.findOne(
        'api::listing.listing' as any,
        candidate as any,
        {
          fields: ['ownerEmail', 'ownerProfileId', 'ownerId', 'listingNo'],
        },
      );
      if (entity && typeof entity === 'object') {
        const map = entity as Record<string, unknown>;
        const email = normalizeEmail(map.ownerEmail);
        const ownerId =
          normalizeOwnerId(map.ownerProfileId) ||
          normalizeOwnerId(map.ownerId) ||
          ownerIdFromEmail(email);
        if (email || ownerId) return { email, ownerId };
      }
    } catch (_) {
      // continue
    }

    const numeric = Number(candidate);
    if (Number.isInteger(numeric) && numeric > 0) {
      try {
        const row = await strapi.db.query('api::listing.listing').findOne({
          where: { id: numeric },
          select: ['ownerEmail', 'ownerProfileId', 'ownerId'],
        } as any);
        if (row && typeof row === 'object') {
          const map = row as Record<string, unknown>;
          const email = normalizeEmail(map.ownerEmail);
          const ownerId =
            normalizeOwnerId(map.ownerProfileId) ||
            normalizeOwnerId(map.ownerId) ||
            ownerIdFromEmail(email);
          if (email || ownerId) return { email, ownerId };
        }
      } catch (_) {
        // continue
      }

      try {
        const rows = await strapi.db.query('api::listing.listing').findMany({
          where: { listingNo: numeric },
          select: ['ownerEmail', 'ownerProfileId', 'ownerId'],
          limit: 1,
        } as any);
        const row = Array.isArray(rows) ? rows[0] : null;
        if (row && typeof row === 'object') {
          const map = row as Record<string, unknown>;
          const email = normalizeEmail(map.ownerEmail);
          const ownerId =
            normalizeOwnerId(map.ownerProfileId) ||
            normalizeOwnerId(map.ownerId) ||
            ownerIdFromEmail(email);
          if (email || ownerId) return { email, ownerId };
        }
      } catch (_) {
        // continue
      }
    }

    try {
      const row = await strapi.db.query('api::listing.listing').findOne({
        where: { documentId: candidate },
        select: ['ownerEmail', 'ownerProfileId', 'ownerId'],
      } as any);
      if (row && typeof row === 'object') {
        const map = row as Record<string, unknown>;
        const email = normalizeEmail(map.ownerEmail);
        const ownerId =
          normalizeOwnerId(map.ownerProfileId) ||
          normalizeOwnerId(map.ownerId) ||
          ownerIdFromEmail(email);
        if (email || ownerId) return { email, ownerId };
      }
    } catch (_) {
      // continue
    }
  }

  return null;
};

/**
 * NOTIFICATION_N1_SECURITY_FIX_REPORT.md BUG-NOTIF-001: server-side
 * recipient resolvers for the "social interaction" notification producers
 * (favorite/like on a listing or logistics load, a comment/favorite on a
 * profile) that used to trust a client-supplied targetEmail/targetProfileId
 * outright. Each resolver re-derives the real owner from the entity's own
 * stored fields -- the client only ever supplies the entityId, never the
 * recipient itself. Reuses resolveListingOwnerByAnyId as-is for listings.
 */
export type ResolvedOwnerIdentity = { email: string; ownerId: string } | null;

/** logistics-load.ownerKey uses the same `id:`/`email:`-prefixed scheme
 * documented on matchesOwnerKey above (SEMANTIC_CONTRACT_S1). */
const parseOwnerKey = (rawKey: unknown): ResolvedOwnerIdentity => {
  const raw = String(rawKey ?? '').trim();
  if (!raw) return null;
  if (raw.toLowerCase().startsWith('email:')) {
    const email = normalizeEmail(raw.slice('email:'.length));
    if (!email) return null;
    return { email, ownerId: ownerIdFromEmail(email) };
  }
  const profileId = raw.startsWith('id:') ? raw.slice('id:'.length).trim() : raw;
  if (!profileId || profileId === 'guest' || profileId.includes('@')) return null;
  return { email: '', ownerId: profileId };
};

export const resolveLogisticsLoadOwnerByAnyId = async (
  strapi: Core.Strapi,
  rawLoadId: unknown,
): Promise<ResolvedOwnerIdentity> => {
  const candidates = idCandidates(rawLoadId);
  if (candidates.length === 0) return null;
  for (const candidate of candidates) {
    try {
      const row = await loadEntityByRouteId(
        strapi,
        'api::logistics-load.logistics-load',
        candidate,
        ['ownerKey'],
      );
      if (row) {
        const owner = parseOwnerKey((row as Record<string, unknown>).ownerKey);
        if (owner) return owner;
      }
    } catch (_) {
      // continue
    }
  }
  return null;
};

export const resolveProcessedProductOwnerByAnyId = async (
  strapi: Core.Strapi,
  rawProductId: unknown,
): Promise<ResolvedOwnerIdentity> => {
  const candidates = idCandidates(rawProductId);
  if (candidates.length === 0) return null;
  for (const candidate of candidates) {
    try {
      const row = await loadEntityByRouteId(
        strapi,
        'api::processed-product.processed-product',
        candidate,
        ['ownerId', 'ownerEmail'],
      );
      if (row) {
        const map = row as Record<string, unknown>;
        const email = normalizeEmail(map.ownerEmail);
        const ownerId = normalizeOwnerId(map.ownerId) || ownerIdFromEmail(email);
        if (email || ownerId) return { email, ownerId };
      }
    } catch (_) {
      // continue
    }
  }
  return null;
};

/** Confirms a profileId belongs to a REAL, existing profile-setting row --
 * used for profile-comment/favorite-profile notifications, where anyone
 * can legitimately be notified about their own public profile, but the
 * claimed target must be a real registered profile, not an arbitrary
 * client-supplied string. */
export const resolveProfileOwnerIfExists = async (
  strapi: Core.Strapi,
  rawProfileId: unknown,
): Promise<ResolvedOwnerIdentity> => {
  const profileId = String(rawProfileId ?? '').trim();
  if (!profileId) return null;
  try {
    const row = await strapi.db.query('api::profile-setting.profile-setting').findOne({
      where: { profileId },
      select: ['profileId', 'ownerEmail'],
    } as any);
    if (!row) return null;
    const map = row as Record<string, unknown>;
    const email = normalizeEmail(map.ownerEmail);
    const ownerId = normalizeOwnerId(map.profileId) || profileId;
    return { email, ownerId };
  } catch (_) {
    return null;
  }
};

export const resolveThreadParticipantsByThreadId = async (
  strapi: Core.Strapi,
  rawThreadId: unknown,
): Promise<ThreadParticipants | null> => {
  const threadId = String(rawThreadId ?? '').trim();
  if (!threadId) return null;

  try {
    const row = await strapi.db.query('api::thread.thread').findOne({
      where: { threadId },
      select: [
        'requesterEmail',
        'requesterProfileId',
        'receiverEmail',
        'receiverProfileId',
      ],
    } as any);
    if (!row || typeof row !== 'object') return null;

    const map = row as Record<string, unknown>;
    let requesterEmail = normalizeEmail(map.requesterEmail);
    let requesterProfileId = normalizeOwnerId(map.requesterProfileId);
    let receiverEmail = normalizeEmail(map.receiverEmail);
    let receiverProfileId = normalizeOwnerId(map.receiverProfileId);

    if (!requesterProfileId && requesterEmail) {
      requesterProfileId = ownerIdFromEmail(requesterEmail);
    }
    if (!receiverProfileId && receiverEmail) {
      receiverProfileId = ownerIdFromEmail(receiverEmail);
    }

    return {
      requesterEmail,
      requesterProfileId,
      receiverEmail,
      receiverProfileId,
    };
  } catch (_) {
    return null;
  }
};

export const readIdentity = (ctx: any): SessionIdentity | null => {
  const email = normalizeEmail(ctx?.state?.user?.email);
  if (!email) return null;
  const ownerId = ownerIdFromEmail(email);
  if (!ownerId) return null;
  return { email, ownerId };
};

/**
 * SEMANTIC_CONTRACT_S1: the one canonical way to check whether a stored
 * `type:value` owner/actor key (e.g. logistics-load's `ownerKey`,
 * logistics-vehicle's `transporterKey`, offer's `transporterKey`) belongs
 * to the given session identity. Strips a leading `id:`/`email:`/
 * `profile:`/`username:` prefix and compares the remainder against the
 * identity's email-derived ownerId or raw email -- the exact scheme
 * Flutter's own actor-key builders (`_currentLogisticsActorKey`,
 * `ownerIdFromEmail`) always produce. This is the same comparison
 * `logistics-offer.ts`'s own `matchesTransporter` already used
 * successfully; logistics-load/vehicle's ownership checks previously
 * implemented a DIFFERENT, real-numeric-Strapi-user-id-based scheme here
 * that Flutter never actually sends, making owner update/delete always
 * fail. See SEMANTIC_CONTRACT_S1_CRITICAL_FIX_REPORT.md.
 */
export const matchesOwnerKey = (
  rawKey: unknown,
  identity: SessionIdentity | null,
): boolean => {
  if (!identity) return false;
  const raw = String(rawKey ?? '').trim().toLowerCase();
  if (!raw) return false;
  const normalized = raw.replace(/^(id:|email:|profile:|username:)/, '');
  return normalized === identity.ownerId.toLowerCase() || normalized === identity.email;
};

export const denyNoIdentity = (ctx: any): false => {
  if (typeof ctx?.unauthorized === 'function') {
    ctx.unauthorized('Kimlik dogrulanamadi.');
  } else if (typeof ctx?.throw === 'function') {
    ctx.throw(401, 'Kimlik dogrulanamadi.');
  } else {
    ctx.status = 401;
    ctx.body = { error: { message: 'Kimlik dogrulanamadi.' } };
  }
  return false;
};

export const denyForbidden = (ctx: any, message: string): false => {
  if (typeof ctx?.forbidden === 'function') {
    ctx.forbidden(message);
  } else if (typeof ctx?.throw === 'function') {
    ctx.throw(403, message);
  } else {
    ctx.status = 403;
    ctx.body = { error: { message } };
  }
  return false;
};

export const mergeScopeOrFilter = (ctx: any, orClauses: object[]) => {
  const query = (ctx.query ?? {}) as Record<string, unknown>;
  const filters = (query.filters ?? {}) as Record<string, unknown>;
  const hasExistingFilters = Object.keys(filters).length > 0;
  const nextFilter = hasExistingFilters
    ? { $and: [filters, { $or: [...orClauses] }] }
    : { $or: [...orClauses] };
  ctx.query = {
    ...query,
    filters: nextFilter,
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

  // Strapi v5 route params often use documentId.
  try {
    const viaDocumentId = await strapi.db.query(uid as any).findOne({
      where: { documentId: id },
      select: fields,
    } as any);
    if (viaDocumentId && typeof viaDocumentId === 'object') {
      return viaDocumentId as Record<string, unknown>;
    }
  } catch (_) {
    // continue
  }

  return null;
};
