/**
 * Shared constants, types, and response-envelope builders for the Engagement
 * API contract (see ENGAGEMENT_API_CONTRACT.md, v1 revised).
 *
 * This module is the single source of truth for: which targetType/action
 * combinations are supported, which content-type UID and field names back
 * each target, the response envelope shapes, and the error-code table. No
 * controller should hard-code a UID string or silently ignore an
 * unsupported combination — always go through `assertEngagementSupported`.
 */

export const CONTRACT_VERSION = '1';

export type EngagementTargetType =
  | 'listing'
  | 'logistics-load'
  | 'logistics-vehicle'
  | 'processed-product'
  | 'ad'
  | 'hub-content'
  | 'profile';

export type EngagementMembershipKind = 'like' | 'favorite';

export const ENGAGEMENT_TARGET_TYPES: EngagementTargetType[] = [
  'listing',
  'logistics-load',
  'logistics-vehicle',
  'processed-product',
  'ad',
  'hub-content',
  'profile',
];

export const isEngagementTargetType = (value: unknown): value is EngagementTargetType =>
  typeof value === 'string' &&
  (ENGAGEMENT_TARGET_TYPES as string[]).includes(value);

/** Strapi content-type UID backing each target, per the domain matrix. */
export const TARGET_UID: Record<EngagementTargetType, string> = {
  listing: 'api::listing.listing',
  'logistics-load': 'api::logistics-load.logistics-load',
  'logistics-vehicle': 'api::logistics-vehicle.logistics-vehicle',
  'processed-product': 'api::processed-product.processed-product',
  ad: 'api::ad.ad',
  'hub-content': 'api::hub-content.hub-content',
  profile: 'api::profile-setting.profile-setting',
};

interface DomainSupport {
  like: boolean;
  favorite: boolean;
  view: boolean;
  comment: boolean;
  share: boolean;
}

/**
 * Domain x engagement-type support matrix (ENGAGEMENT_API_CONTRACT.md §4.6).
 * Comment/share are listed for completeness but only "listing" has a real
 * implementation in this phase (hub-content comment migration is deferred).
 */
export const DOMAIN_SUPPORT: Record<EngagementTargetType, DomainSupport> = {
  listing: { like: true, favorite: true, view: true, comment: true, share: true },
  'logistics-load': { like: true, favorite: true, view: true, comment: false, share: false },
  'logistics-vehicle': { like: false, favorite: false, view: true, comment: false, share: false },
  'processed-product': { like: true, favorite: true, view: true, comment: false, share: false },
  ad: { like: true, favorite: false, view: true, comment: false, share: false },
  'hub-content': { like: true, favorite: false, view: false, comment: false, share: false },
  profile: { like: false, favorite: false, view: true, comment: false, share: false },
};

/** Counter + version field names on the target's own content-type row. */
export const COUNTER_FIELD: Partial<Record<EngagementTargetType, Record<EngagementMembershipKind, string>>> = {
  listing: { like: 'likeCount', favorite: 'favoriteCount' },
  'logistics-load': { like: 'likeCount', favorite: 'favoriteCount' },
  'processed-product': { like: 'likeCount', favorite: 'favoriteCount' },
  ad: { like: 'likes', favorite: 'favoriteCount' },
  'hub-content': { like: 'likes', favorite: 'favoriteCount' },
};

export const VIEW_COUNT_FIELD: Partial<Record<EngagementTargetType, string>> = {
  listing: 'viewCount',
  'logistics-load': 'viewCount',
  'logistics-vehicle': 'viewCount',
  'processed-product': 'viewCount',
  ad: 'impressions',
  profile: 'viewCount',
};

/** engagementVersion field name — identical on every target, added in Aşama 8. */
export const VERSION_FIELD = 'engagementVersion';

export type EngagementErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'ENGAGEMENT_NOT_SUPPORTED'
  | 'RATE_LIMITED'
  | 'CONFLICT'
  | 'SERVER_ERROR';

export const ERROR_HTTP_STATUS: Record<EngagementErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  ENGAGEMENT_NOT_SUPPORTED: 400,
  RATE_LIMITED: 429,
  CONFLICT: 409,
  SERVER_ERROR: 500,
};

export interface EngagementErrorBody {
  success: false;
  error: { code: EngagementErrorCode; message: string };
  contractVersion: string;
}

export const buildErrorBody = (code: EngagementErrorCode, message: string): EngagementErrorBody => ({
  success: false,
  error: { code, message },
  contractVersion: CONTRACT_VERSION,
});

/** Sends a standard error envelope on ctx with the code's mapped HTTP status. */
export const sendEngagementError = (ctx: any, code: EngagementErrorCode, message: string): void => {
  ctx.status = ERROR_HTTP_STATUS[code];
  ctx.body = buildErrorBody(code, message);
};

/**
 * Validates targetType is known and the requested action is supported for
 * it (ENGAGEMENT_API_CONTRACT.md §4.6 matrix). Returns true and does
 * nothing if supported; sends a 400 ENGAGEMENT_NOT_SUPPORTED and returns
 * false otherwise. Never silently ignore an unsupported combination.
 */
export const assertEngagementSupported = (
  ctx: any,
  targetType: unknown,
  action: keyof DomainSupport,
): targetType is EngagementTargetType => {
  if (!isEngagementTargetType(targetType)) {
    sendEngagementError(ctx, 'VALIDATION_ERROR', `Bilinmeyen targetType: ${String(targetType)}`);
    return false;
  }
  if (!DOMAIN_SUPPORT[targetType][action]) {
    sendEngagementError(
      ctx,
      'ENGAGEMENT_NOT_SUPPORTED',
      `${action} is not supported for ${targetType}.`,
    );
    return false;
  }
  return true;
};

export interface ToggleEnvelopeInput {
  active: boolean;
  changed: boolean;
  count: number;
  targetType: EngagementTargetType;
  targetId: string;
  updatedAt: string;
  serverVersion: number;
}

export const buildToggleBody = (input: ToggleEnvelopeInput) => ({
  success: true as const,
  active: input.active,
  changed: input.changed,
  count: input.count,
  target: { type: input.targetType, id: input.targetId },
  updatedAt: input.updatedAt,
  serverVersion: input.serverVersion,
  contractVersion: CONTRACT_VERSION,
});

export interface ViewEnvelopeInput {
  incremented: boolean;
  count: number;
  targetType: EngagementTargetType;
  targetId: string;
  updatedAt: string;
  serverVersion: number;
}

export const buildViewBody = (input: ViewEnvelopeInput) => ({
  success: true as const,
  incremented: input.incremented,
  count: input.count,
  target: { type: input.targetType, id: input.targetId },
  updatedAt: input.updatedAt,
  serverVersion: input.serverVersion,
  contractVersion: CONTRACT_VERSION,
});

export interface EventEnvelopeInput {
  data: Record<string, unknown>;
  count: number;
  targetType: EngagementTargetType;
  targetId: string;
  serverVersion: number;
}

export const buildEventBody = (input: EventEnvelopeInput) => ({
  success: true as const,
  data: input.data,
  count: input.count,
  target: { type: input.targetType, id: input.targetId },
  serverVersion: input.serverVersion,
  contractVersion: CONTRACT_VERSION,
});

const GUEST_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves the actor key for a request per ENGAGEMENT_API_CONTRACT.md §2:
 * authenticated users derive it from the JWT identity (never trusted from
 * the request body); guests may only be recognized via a well-formed,
 * client-generated device UUID sent as `guestActorId` (view/share only —
 * like/favorite/comment always require auth, see per-endpoint checks).
 */
export const resolveActorKey = (ctx: any): string | null => {
  const email = (ctx?.state?.user?.email ?? '').toString().trim().toLowerCase();
  if (email) return `user:${email}`;
  const body = (ctx?.request?.body ?? {}) as Record<string, unknown>;
  const data = (body.data && typeof body.data === 'object' ? body.data : body) as Record<string, unknown>;
  const guestId = String(data.guestActorId ?? '').trim();
  if (guestId && GUEST_UUID_RE.test(guestId)) {
    return `guest:${guestId.toLowerCase()}`;
  }
  return null;
};

export const requireAuthenticatedActorKey = (ctx: any): string | null => {
  const email = (ctx?.state?.user?.email ?? '').toString().trim().toLowerCase();
  return email ? `user:${email}` : null;
};
