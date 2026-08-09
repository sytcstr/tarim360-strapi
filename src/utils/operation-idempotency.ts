/**
 * Shared request-idempotency helper for repeatable-event endpoints
 * (comment, share — ENGAGEMENT_API_CONTRACT.md §3.2), as distinct from
 * the interaction-identity model used by like/favorite (§3.1). Every
 * such endpoint stores the client-generated `operationId` plus a
 * fingerprint of the request's meaningful fields; a retry with the same
 * operationId AND the same fingerprint is treated as idempotent (returns
 * the original result), a retry with the same operationId but a
 * DIFFERENT fingerprint is rejected with CONFLICT — mirroring offer's
 * proven offerId-based pattern (ENGAGEMENT_API_CONTRACT.md §2.4/§3.2).
 */
import { createHash } from 'node:crypto';

const OPERATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isValidOperationId = (value: unknown): value is string =>
  typeof value === 'string' && OPERATION_ID_RE.test(value.trim());

/** Deterministic fingerprint of the fields that define "the same
 * request" — key order doesn't matter, values are compared as given. */
export const fingerprintPayload = (payload: Record<string, unknown>): string => {
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(payload).sort()) {
    normalized[key] = payload[key];
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
};

export type OperationResolution =
  | { status: 'new' }
  | { status: 'duplicate'; existing: Record<string, any> }
  | { status: 'conflict' };

/**
 * Looks up `operationId` on the given content-type (which must have both
 * an `operationId` (unique) and `payloadFingerprint` string attribute).
 * Does not create anything — callers create on `status: 'new'` and must
 * handle a unique-constraint race on that create the same way the
 * membership/view services do (catch, re-query, treat as duplicate).
 */
export const resolveOperation = async (
  strapiInstance: any,
  uid: string,
  operationId: string,
  fingerprint: string,
): Promise<OperationResolution> => {
  const existing = await strapiInstance.db.query(uid).findOne({ where: { operationId } });
  if (!existing) return { status: 'new' };
  if (existing.payloadFingerprint === fingerprint) {
    return { status: 'duplicate', existing };
  }
  return { status: 'conflict' };
};
