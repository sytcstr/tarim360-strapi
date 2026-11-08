/**
 * Atomic daily quota for the AI assistant's two channels (text/vision).
 *
 * The old gate (ai.ts's loadTodayUsage, pre-fix) counted existing ai-log
 * rows and compared to the limit BEFORE calling the provider, with the
 * ai-log row only written AFTER a successful reply. Two concurrent
 * requests at count=19/limit=20 both read 19, both pass, both call the
 * provider, both insert a row -- the quota overshoots and a single
 * remaining slot can be spent twice.
 *
 * Fixed by making the slot claim itself the atomic operation: each unit of
 * capacity for a given owner+day+channel is a distinct row whose `slotKey`
 * (`<owner>:<day>:<channel>:<slotIndex>`) is DB-unique. Claiming slot N is
 * "try to insert the row for N"; the database's own unique index is what
 * arbitrates two concurrent attempts at the same index, not an in-memory
 * lock (mirrors this codebase's existing operationId idempotency pattern -
 * see operation-idempotency.ts - which relies on the same kind of
 * unique-constraint race resolution, not a lock).
 *
 * A slot can outlive the request that claimed it (the Strapi PROCESS itself
 * crashes before the linked ai-request row is ever marked 'completed' or
 * 'failed') -- claimUsageSlot below reclaims a slot whose linked request is
 * provably abandoned (missing, 'unknown', 'failed', or a 'pending' row old
 * enough to be considered dead) instead of leaving it to hold a unit of
 * quota hostage forever. This self-heals on the NEXT claim attempt by ANY
 * request (not only a retry under the same operationId), so a stuck
 * reservation does not require that exact operationId to ever come back.
 */
import { AI_TIMEOUT_MS } from './agri-ai';

const AI_USAGE_SLOT_UID = 'api::ai-usage-slot.ai-usage-slot';
export const AI_REQUEST_UID = 'api::ai-request.ai-request';

export type AiUsageChannel = 'text' | 'vision';

// A 'pending' ai-request row older than this is treated as abandoned (the
// handler that created it crashed/restarted before finishing) rather than
// genuinely still in flight. Generous margin over the provider's own
// AI_TIMEOUT_MS budget plus request overhead.
export const PENDING_STALE_AFTER_MS = AI_TIMEOUT_MS + 15000;

export const isStalePending = (row: Record<string, unknown>): boolean => {
  const updatedAt = String(row.updatedAt || row.createdAt || '').trim();
  const at = updatedAt ? Date.parse(updatedAt) : NaN;
  if (!Number.isFinite(at)) return true;
  return Date.now() - at > PENDING_STALE_AFTER_MS;
};

export const dayKeyFor = (date: Date): string => {
  const y = date.getFullYear().toString().padStart(4, '0');
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const slotKeyFor = (
  ownerProfileId: string,
  dayKey: string,
  channel: AiUsageChannel,
  slotIndex: number,
) => `${ownerProfileId}:${dayKey}:${channel}:${slotIndex}`;

/** True (and deletes the slot row as a side effect) when the request that
 * claimed this slot is provably never going to finish: no ai-request row
 * for it at all, a terminal 'unknown'/'failed' outcome, or a 'pending' row
 * old enough to be considered a dead handler. Leaves a genuinely live
 * (fresh pending, or completed) slot untouched. */
const reclaimIfAbandoned = async (
  strapiRef: any,
  slotRow: Record<string, unknown>,
): Promise<boolean> => {
  const operationId = String(slotRow.operationId || '').trim();
  const linked = operationId
    ? await strapiRef.db
        .query(AI_REQUEST_UID)
        .findOne({ where: { operationId } })
    : null;
  const abandoned =
    !linked ||
    linked.status === 'unknown' ||
    linked.status === 'failed' ||
    (linked.status === 'pending' && isStalePending(linked));
  if (!abandoned) return false;
  await strapiRef.db
    .query(AI_USAGE_SLOT_UID)
    .delete({ where: { id: slotRow.id } })
    .catch(() => {});
  return true;
};

/**
 * Tries to claim the next free slot (0..limit-1) for this owner/day/channel.
 * Returns `{claimed:false}` once every slot is taken (the daily limit is
 * genuinely reached) - the atomic, race-safe replacement for the old
 * count-then-compare check. Bounded to `limit` attempts; `limit` is always
 * the small configured daily cap (20 / 3), so this is cheap.
 */
export const claimUsageSlot = async (
  strapiRef: any,
  params: {
    ownerProfileId: string;
    dayKey: string;
    channel: AiUsageChannel;
    limit: number;
    operationId: string;
  },
): Promise<{ claimed: boolean; slotKey?: string }> => {
  const { ownerProfileId, dayKey, channel, limit, operationId } = params;
  for (let slotIndex = 0; slotIndex < limit; slotIndex += 1) {
    const slotKey = slotKeyFor(ownerProfileId, dayKey, channel, slotIndex);
    try {
      await strapiRef.entityService.create(AI_USAGE_SLOT_UID as any, {
        data: { slotKey, ownerProfileId, dayKey, channel, operationId },
      });
      return { claimed: true, slotKey };
    } catch (err) {
      // Could be a genuine race on this exact slot (someone else claimed it
      // first), an abandoned slot worth reclaiming, or an unrelated infra
      // error. Only treat it as a race/reclaim - and move on - if a row for
      // this exact key now exists; otherwise this is a real failure and
      // must not be swallowed as a fake "quota exhausted".
      const existingSlot = await strapiRef.db
        .query(AI_USAGE_SLOT_UID)
        .findOne({ where: { slotKey } });
      if (!existingSlot) throw err;

      if (await reclaimIfAbandoned(strapiRef, existingSlot)) {
        try {
          await strapiRef.entityService.create(AI_USAGE_SLOT_UID as any, {
            data: { slotKey, ownerProfileId, dayKey, channel, operationId },
          });
          return { claimed: true, slotKey };
        } catch (_err2) {
          // Someone else grabbed this freed slot first - fall through to
          // the next index like a normal occupied slot.
        }
      }
    }
  }
  return { claimed: false };
};

/** Frees a slot this request claimed but never actually spent (the provider
 * call failed, or turned out unnecessary) - so a failed/incomplete attempt
 * never permanently locks out a real unit of quota. */
export const releaseUsageSlot = async (
  strapiRef: any,
  slotKey: string,
): Promise<void> => {
  const row = await strapiRef.db
    .query(AI_USAGE_SLOT_UID)
    .findOne({ where: { slotKey } });
  if (!row) return;
  await strapiRef.db.query(AI_USAGE_SLOT_UID).delete({ where: { id: row.id } });
};

/** Same, looked up by the operationId that claimed it rather than the slot
 * key itself - used when a later request discovers its OWN prior attempt
 * went stale and wants to free whatever it reserved. */
export const releaseUsageSlotByOperationId = async (
  strapiRef: any,
  operationId: string,
): Promise<void> => {
  const row = await strapiRef.db
    .query(AI_USAGE_SLOT_UID)
    .findOne({ where: { operationId } });
  if (!row) return;
  await strapiRef.db.query(AI_USAGE_SLOT_UID).delete({ where: { id: row.id } });
};

export const countUsageSlotsToday = async (
  strapiRef: any,
  params: { ownerProfileId: string; dayKey: string; channel: AiUsageChannel },
): Promise<number> => {
  const { ownerProfileId, dayKey, channel } = params;
  return strapiRef.db.query(AI_USAGE_SLOT_UID).count({
    where: { ownerProfileId, dayKey, channel },
  });
};
