import { randomUUID } from 'crypto';
import { readIdentity } from '../../../utils/identity';
import {
  generateAgriAiReply,
  AgriAiProviderError,
  isPromptWithinSupportedScope,
  type AgriAiResult,
} from '../../../utils/agri-ai';
import { isPremiumActiveFromProfile } from '../../../utils/premium-sync';
import {
  fingerprintPayload,
  isValidOperationId,
  resolveOperation,
} from '../../../utils/operation-idempotency';
import {
  claimUsageSlot,
  releaseUsageSlot,
  releaseUsageSlotByOperationId,
  countUsageSlotsToday,
  dayKeyFor,
  isStalePending,
  AI_REQUEST_UID,
  type AiUsageChannel,
} from '../../../utils/agri-ai-quota';

const AI_LOG_UID = 'api::ai-log.ai-log';
const PROFILE_SETTING_UID = 'api::profile-setting.profile-setting';

const asString = (value: unknown): string => String(value ?? '').trim();
const REMOTE_AI_ENABLED = asString(process.env.OPENAI_API_KEY).length > 0;
const DEFAULT_DAILY_TEXT_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.AGRI_AI_DAILY_TEXT_LIMIT ?? '20', 10) || 20,
);
const DEFAULT_DAILY_VISION_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.AGRI_AI_DAILY_VISION_LIMIT ?? '3', 10) || 3,
);
const AI_LOG_RETENTION_DAYS = Math.max(
  1,
  Number.parseInt(process.env.AGRI_AI_LOG_RETENTION_DAYS ?? '20', 10) || 20,
);

const asBool = (value: unknown, fallback = false): boolean => {
  if (typeof value === 'boolean') return value;
  const raw = asString(value).toLowerCase();
  if (raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on') {
    return true;
  }
  if (raw === 'false' || raw === '0' || raw === 'no' || raw === 'off') {
    return false;
  }
  return fallback;
};

const dayStartIso = () => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
};

const dayEndIso = () => {
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    23,
    59,
    59,
    999,
  ).toISOString();
};

const asStringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map((row) => asString(row)).filter((row) => row.length > 0)
    : [];

/**
 * SEMANTIC_CONTRACT_S1: activation itself (missing endsAt = active/
 * unlimited, matching premium-sync.ts's own canonical rule) now delegates
 * to isPremiumActiveFromProfile instead of a separate, disagreeing local
 * reimplementation (the old version returned false for a missing endsAt,
 * denying AI access to exactly the members the canonical rule considers
 * active). `hasAiAssistant` stays a separate, AI-specific plan-tier gate
 * on top. See SEMANTIC_CONTRACT_S1_CRITICAL_FIX_REPORT.md.
 */
const hasActiveAiAccess = (row: Record<string, unknown> | null): boolean => {
  if (!row) return false;
  const premium =
    ((row.activePremium ??
      row.activePremiumSubscription ??
      null) as Record<string, unknown> | null) ?? null;
  if (!premium) return false;
  if (!asBool(premium.hasAiAssistant, false)) return false;
  return isPremiumActiveFromProfile(row);
};

const ensureAiAccess = async (ctx: any) => {
  const identity = readIdentity(ctx);
  if (!identity) {
    ctx.unauthorized('Yapay zeka asistani icin giris yapmalisiniz.');
    return null;
  }

  const profile = (await strapi.db.query(PROFILE_SETTING_UID).findOne({
    where: { profileId: identity.ownerId },
    select: ['id', 'profileId', 'activePremium', 'activePremiumSubscription'],
  } as any)) as Record<string, unknown> | null;

  if (!hasActiveAiAccess(profile)) {
    ctx.forbidden('Yapay zeka asistani Pro Premium kullanicilarina ozeldir.');
    return null;
  }

  return identity;
};

const createAiLog = async (input: {
  ownerEmail: string;
  ownerProfileId: string;
  prompt: string;
  rawPrompt: string;
  scope: string;
  hasImage: boolean;
  result: {
    answer: string;
    recommendations: string[];
    suspectedIssue?: string;
    confidenceLabel: string;
    provider: string;
  };
}) => {
  await strapi.entityService.create(AI_LOG_UID as any, {
    data: {
      ownerEmail: input.ownerEmail,
      ownerProfileId: input.ownerProfileId,
      prompt: input.prompt,
      rawPrompt: input.rawPrompt,
      scope: input.scope,
      answer: input.result.answer,
      conversation:
        `Kullanici Sorusu:\n${input.rawPrompt}\n\n` +
        `Sistem Cevabi:\n${input.result.answer}`,
      recommendations: input.result.recommendations,
      suspectedIssue: input.result.suspectedIssue ?? '',
      confidenceLabel: input.result.confidenceLabel,
      provider: input.result.provider,
      model: input.result.provider,
      hasImage: input.hasImage,
    },
  });
};

const cleanupOldAiLogs = async (ownerProfileId: string) => {
  const cutoff = new Date(
    Date.now() - AI_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const oldRows = (await strapi.entityService.findMany(AI_LOG_UID as any, {
    filters: {
      ownerProfileId,
      createdAt: {
        $lt: cutoff,
      },
    },
    sort: ['createdAt:asc'],
    limit: 500,
    fields: ['id'],
  })) as Record<string, unknown>[];

  for (const row of Array.isArray(oldRows) ? oldRows : []) {
    const id = Number(row.id ?? 0);
    if (!Number.isInteger(id) || id <= 0) continue;
    await strapi.entityService.delete(AI_LOG_UID as any, id as any);
  }
};

/**
 * textRemoteCount/imageRemoteCount now come from the atomic ai-usage-slot
 * ledger (agri-ai-quota.ts), not from counting ai-log rows after the fact -
 * ai-log is written only once a reply is fully produced, which is exactly
 * the gap that let two concurrent near-limit requests both pass the old
 * count-then-compare check. todayCount/historyCount/lastProvider stay
 * ai-log-based (unaffected, purely informational/history fields).
 */
const loadTodayUsage = async (ownerProfileId: string) => {
  const dayKey = dayKeyFor(new Date());
  const [rows, textRemoteCount, imageRemoteCount] = await Promise.all([
    strapi.entityService.findMany(AI_LOG_UID as any, {
      filters: {
        ownerProfileId,
        createdAt: { $gte: dayStartIso(), $lte: dayEndIso() },
      },
      sort: ['createdAt:desc'],
      limit: 200,
      fields: ['provider', 'createdAt'],
    }) as Promise<Record<string, unknown>[]>,
    countUsageSlotsToday(strapi, { ownerProfileId, dayKey, channel: 'text' }),
    countUsageSlotsToday(strapi, { ownerProfileId, dayKey, channel: 'vision' }),
  ]);

  const list = Array.isArray(rows) ? rows : [];
  const lastProvider = list.length > 0 ? asString(list[0]?.provider) : '';

  return {
    todayCount: list.length,
    textRemoteCount,
    imageRemoteCount,
    textRemoteLimit: DEFAULT_DAILY_TEXT_LIMIT,
    imageRemoteLimit: DEFAULT_DAILY_VISION_LIMIT,
    historyCount: list.length,
    lastProvider,
  };
};

/**
 * A real OpenAI call was attempted and failed. Log ONLY error type, duration
 * and a request id - never the question text, photo data, tokens or the API
 * key - and answer with an explicit error so the client can show a real
 * error state (and offer retry) instead of a disguised local answer.
 */
const respondToAiProviderFailure = (ctx: any, err: AgriAiProviderError) => {
  const requestId = randomUUID();
  strapi.log.warn('[agri-ai] provider request failed', {
    type: err.type,
    durationMs: err.durationMs,
    requestId,
  });
  ctx.internalServerError(
    `Yapay zeka servisine su anda ulasilamiyor, lutfen tekrar deneyin. (hata kodu: ${requestId})`,
  );
};

const respondStillProcessing = (ctx: any) => {
  ctx.status = 409;
  ctx.body = {
    data: null,
    error: {
      status: 409,
      name: 'RequestInProgress',
      message:
        'Onceki istegin hala isleniyor. Lutfen birkac saniye sonra tekrar deneyin.',
    },
  };
};

/**
 * A prior attempt under this SAME operationId went stale (its 'pending' row
 * is old enough that the handler that created it almost certainly
 * crashed/restarted before ever recording an outcome) - whether the
 * provider was actually reached is now permanently unknowable. Rather than
 * silently opening a second provider call under the same id, this is a
 * terminal, honest answer: tell the caller the outcome could not be
 * confirmed and a genuinely NEW request (new operationId) is needed.
 */
const respondUnverified = (ctx: any) => {
  ctx.status = 422;
  ctx.body = {
    data: null,
    error: {
      status: 422,
      name: 'RequestUnverified',
      message:
        'Onceki istegin sonucu dogrulanamadi (sunucu yeniden baslamis olabilir). Lutfen yeni bir istek baslatin.',
    },
  };
};

const respondWithResult = (
  ctx: any,
  result: AgriAiResult,
  identity: { email: string; ownerId: string },
  forceRulesOnly: boolean,
) => {
  ctx.body = {
    data: {
      ...result,
      email: identity.email,
      ownerId: identity.ownerId,
      forceRulesOnly,
    },
  };
};

type ChannelInput = {
  channel: AiUsageChannel;
  limit: number;
  prompt: string;
  rawPrompt: string;
  scope: string;
  imageBase64?: string;
  fileName?: string;
  hasImage: boolean;
};

/**
 * Shared request/quota/idempotency flow for both agriAssistant and
 * agriVision. Every new question carries a client-generated operationId
 * (UUID); "Tekrar Dene" on the SAME question reuses it. The database (not
 * an in-memory lock) arbitrates: operationId is unique on ai-request, and
 * each unit of daily capacity is its own unique-keyed ai-usage-slot row
 * (agri-ai-quota.ts) - two concurrent requests racing for the same
 * operationId or the same last slot can only ever have one winner, enforced
 * by the DB's own unique index, the same mechanism this codebase's existing
 * operationId pattern (operation-idempotency.ts) already relies on.
 */
const handleAgriAiRequest = async (
  ctx: any,
  identity: { email: string; ownerId: string },
  input: ChannelInput,
) => {
  // Old clients (no AI quota/retry round in their build yet) never send
  // operationId at all - the field is simply missing. Generate one
  // server-side so these clients keep getting a working AI reply with the
  // SAME subscription/scope/quota enforcement as before; they just get no
  // replay/dedup guarantee across their own retries (each request becomes a
  // genuinely new one server-side, since nothing ties two of their requests
  // together). A field that IS present but malformed still means the
  // caller is trying to use the idempotency contract and getting it wrong -
  // that stays a hard 400, unchanged.
  const rawOperationId = asString(
    (ctx.request?.body as Record<string, unknown>)?.operationId,
  );
  let operationId: string;
  if (!rawOperationId) {
    operationId = randomUUID();
  } else if (isValidOperationId(rawOperationId)) {
    operationId = rawOperationId;
  } else {
    return ctx.badRequest('operationId zorunlu ve UUID formatinda olmali.');
  }

  const fingerprint = fingerprintPayload({
    channel: input.channel,
    ownerId: identity.ownerId,
    prompt: input.prompt,
    rawPrompt: input.rawPrompt,
    scope: input.scope,
    imageBase64: input.imageBase64 ?? '',
    fileName: input.fileName ?? '',
  });

  const resolution = await resolveOperation(
    strapi,
    AI_REQUEST_UID,
    operationId,
    fingerprint,
  );

  if (resolution.status === 'conflict') {
    return ctx.badRequest(
      'Bu istek kimligi farkli bir soru icerigiyle daha once kullanilmis.',
    );
  }

  let existingRowId: number | null = null;
  if (resolution.status === 'duplicate') {
    const existing = resolution.existing;
    if (existing.status === 'unknown') {
      // This operationId was already given up on (see below) - terminal,
      // forever. Never silently reopen a provider call under it again.
      return respondUnverified(ctx);
    }
    if (existing.status === 'completed' && existing.resultJson) {
      return respondWithResult(
        ctx,
        existing.resultJson as AgriAiResult,
        identity,
        asBool(existing.forceRulesOnly, false),
      );
    }
    if (existing.status === 'pending') {
      if (!isStalePending(existing)) {
        // The first attempt (this device or another) is still genuinely in
        // flight - never open a second provider call for the same question.
        return respondStillProcessing(ctx);
      }
      // Stale: the provider may or may not have been reached before the
      // handler that owned this row crashed/restarted - unknowable now.
      // Do NOT silently retry under the same id (that is exactly the
      // "second provider call after a crash" gap). Free whatever quota
      // this attempt reserved so it isn't held hostage, mark the id
      // terminal, and tell the caller to start a genuinely new request.
      await releaseUsageSlotByOperationId(strapi, operationId);
      await strapi.db.query(AI_REQUEST_UID).update({
        where: { id: existing.id },
        data: { status: 'unknown' },
      });
      return respondUnverified(ctx);
    }
    // status === 'failed': we KNOW what happened (our own code caught and
    // recorded a definitive provider error, not a crash) - safe to retry
    // under the same id. Reuse the existing row (update, not create) so
    // operationId stays unique.
    existingRowId = Number(existing.id);
  }

  const dayKey = dayKeyFor(new Date());
  const withinScope = isPromptWithinSupportedScope({
    prompt: input.prompt,
    rawPrompt: input.rawPrompt,
    scope: input.scope,
    imageBase64: input.imageBase64,
  });

  let claimedSlotKey: string | null = null;
  let forceRulesOnly = false;
  if (withinScope) {
    if (REMOTE_AI_ENABLED) {
      const claim = await claimUsageSlot(strapi, {
        ownerProfileId: identity.ownerId,
        dayKey,
        channel: input.channel,
        limit: input.limit,
        operationId,
      });
      claimedSlotKey = claim.claimed ? claim.slotKey ?? null : null;
      forceRulesOnly = !claim.claimed;
    } else {
      forceRulesOnly = false; // generateAgriAiReply falls back locally anyway (no API key)
    }
  }

  const persistRequestRow = async (
    data: Record<string, unknown>,
  ): Promise<void> => {
    if (existingRowId) {
      await strapi.db
        .query(AI_REQUEST_UID)
        .update({ where: { id: existingRowId }, data });
      return;
    }
    try {
      const created = await strapi.entityService.create(AI_REQUEST_UID as any, {
        data: {
          operationId,
          payloadFingerprint: fingerprint,
          ownerProfileId: identity.ownerId,
          hasImage: input.hasImage,
          ...data,
        },
      });
      // This request is now the owner of this row - every later
      // persistRequestRow call (e.g. pending -> completed/failed) must
      // UPDATE it, never attempt a second create of the same operationId.
      existingRowId = Number((created as Record<string, unknown>).id);
    } catch (err) {
      // Someone else's concurrent "new" request already inserted this
      // operationId first - nothing more to persist on our side; the
      // winner's row is already correct. Mirrors listing-comment.ts's
      // create-then-reresolve recovery for the same race.
      const already = await strapi.db
        .query(AI_REQUEST_UID)
        .findOne({ where: { operationId } });
      if (!already) throw err;
    }
  };

  await persistRequestRow({ status: 'pending' });

  let result: AgriAiResult;
  try {
    result = await generateAgriAiReply({
      prompt: input.prompt,
      rawPrompt: input.rawPrompt,
      scope: input.scope,
      imageBase64: input.imageBase64,
      fileName: input.fileName,
      forceRulesOnly,
    });
  } catch (err) {
    if (claimedSlotKey) await releaseUsageSlot(strapi, claimedSlotKey);
    if (err instanceof AgriAiProviderError) {
      await persistRequestRow({ status: 'failed', errorType: err.type });
      return respondToAiProviderFailure(ctx, err);
    }
    await persistRequestRow({ status: 'failed', errorType: 'unknown' });
    throw err;
  }

  if (claimedSlotKey && result.provider !== 'openai') {
    await releaseUsageSlot(strapi, claimedSlotKey);
  }

  await persistRequestRow({
    status: 'completed',
    resultJson: result,
    forceRulesOnly,
  });

  await cleanupOldAiLogs(identity.ownerId);
  await createAiLog({
    ownerEmail: identity.email,
    ownerProfileId: identity.ownerId,
    prompt: input.prompt,
    rawPrompt: input.rawPrompt,
    scope: input.scope,
    hasImage: input.hasImage,
    result,
  });

  return respondWithResult(ctx, result, identity, forceRulesOnly);
};

export default {
  async agriAssistant(ctx) {
    const identity = await ensureAiAccess(ctx);
    if (!identity) return;

    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const prompt = asString(body.prompt);
    const rawPrompt = asString(body.rawPrompt || body.userPrompt || body.question) || prompt;
    const scope = asString(body.scope) || 'agriculture';
    if (!prompt) {
      return ctx.badRequest('Soru metni zorunludur.');
    }

    return handleAgriAiRequest(ctx, identity, {
      channel: 'text',
      limit: DEFAULT_DAILY_TEXT_LIMIT,
      prompt,
      rawPrompt,
      scope,
      hasImage: false,
    });
  },

  async agriVision(ctx) {
    const identity = await ensureAiAccess(ctx);
    if (!identity) return;

    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const prompt = asString(body.prompt);
    const rawPrompt = asString(body.rawPrompt || body.userPrompt || body.question) || prompt;
    const imageBase64 = asString(body.imageBase64);
    const fileName = asString(body.fileName) || 'image.jpg';
    if (!imageBase64) {
      return ctx.badRequest('Fotograf verisi zorunludur.');
    }

    return handleAgriAiRequest(ctx, identity, {
      channel: 'vision',
      limit: DEFAULT_DAILY_VISION_LIMIT,
      prompt,
      rawPrompt,
      scope: 'agriculture',
      imageBase64,
      fileName,
      hasImage: true,
    });
  },

  async history(ctx) {
    const identity = await ensureAiAccess(ctx);
    if (!identity) return;

    const rawLimit = Number.parseInt(String(ctx.query?.limit ?? '12'), 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(40, Math.max(1, rawLimit))
      : 12;

    const rows = (await strapi.entityService.findMany(AI_LOG_UID as any, {
      filters: {
        ownerProfileId: identity.ownerId,
      },
      sort: ['createdAt:desc'],
      limit,
      fields: [
        'prompt',
        'rawPrompt',
        'answer',
        'conversation',
        'recommendations',
        'suspectedIssue',
        'confidenceLabel',
        'provider',
        'model',
        'scope',
        'hasImage',
        'createdAt',
      ],
    })) as Record<string, unknown>[];

    const list = (Array.isArray(rows) ? rows : [])
      .map((row) => ({
        prompt: asString(row.prompt),
        rawPrompt: asString(row.rawPrompt),
        answer: asString(row.answer),
        conversation: asString(row.conversation),
        recommendations: asStringList(row.recommendations),
        suspectedIssue: asString(row.suspectedIssue),
        confidenceLabel: asString(row.confidenceLabel),
        provider: asString(row.provider),
        model: asString(row.model),
        scope: asString(row.scope),
        hasImage: asBool(row.hasImage, false),
        createdAt: asString(row.createdAt),
      }))
      .reverse();

    ctx.body = {
      data: list,
      meta: {
        count: list.length,
      },
    };
  },

  async usageSummary(ctx) {
    const identity = await ensureAiAccess(ctx);
    if (!identity) return;

    const usage = await loadTodayUsage(identity.ownerId);

    ctx.body = {
      data: {
        ...usage,
        remoteLimit: DEFAULT_DAILY_TEXT_LIMIT,
      },
    };
  },
};
