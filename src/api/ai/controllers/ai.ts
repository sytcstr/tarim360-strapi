import { readIdentity } from '../../../utils/identity';
import { generateAgriAiReply } from '../../../utils/agri-ai';

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

const parseIso = (value: unknown): Date | null => {
  const raw = asString(value);
  if (!raw) return null;
  const time = Date.parse(raw);
  if (Number.isNaN(time)) return null;
  return new Date(time);
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

const hasActiveAiAccess = (row: Record<string, unknown> | null): boolean => {
  if (!row) return false;
  const premium =
    ((row.activePremium ??
      row.activePremiumSubscription ??
      null) as Record<string, unknown> | null) ?? null;
  if (!premium) return false;
  if (!asBool(premium.hasAiAssistant, false)) return false;
  const endsAt = parseIso(premium.endsAt);
  if (!endsAt) return false;
  return endsAt.getTime() > Date.now();
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

const loadTodayUsage = async (ownerProfileId: string) => {
  const rows = (await strapi.entityService.findMany(AI_LOG_UID as any, {
    filters: {
      ownerProfileId,
      createdAt: {
        $gte: dayStartIso(),
        $lte: dayEndIso(),
      },
    },
    sort: ['createdAt:desc'],
    limit: 200,
    fields: ['provider', 'createdAt', 'scope', 'hasImage'],
  })) as Record<string, unknown>[];

  const list = Array.isArray(rows) ? rows : [];
  const remoteRows = list.filter(
    (row) => asString(row.provider).toLowerCase() === 'openai',
  );
  const textRemoteCount = remoteRows.filter(
    (row) => !asBool(row.hasImage, false),
  ).length;
  const imageRemoteCount = remoteRows.filter((row) => asBool(row.hasImage, false))
    .length;
  const lastProvider = list.length > 0 ? asString(list[0]?.provider) : '';

  return {
    todayCount: list.length,
    remoteCount: remoteRows.length,
    textRemoteCount,
    imageRemoteCount,
    textRemoteLimit: DEFAULT_DAILY_TEXT_LIMIT,
    imageRemoteLimit: DEFAULT_DAILY_VISION_LIMIT,
    historyCount: list.length,
    lastProvider,
  };
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

    const usage = await loadTodayUsage(identity.ownerId);
    const forceRulesOnly =
      REMOTE_AI_ENABLED &&
      usage.textRemoteCount >= DEFAULT_DAILY_TEXT_LIMIT;

    const result = await generateAgriAiReply({
      prompt,
      rawPrompt,
      scope,
      forceRulesOnly,
    });
    await cleanupOldAiLogs(identity.ownerId);
    await createAiLog({
      ownerEmail: identity.email,
      ownerProfileId: identity.ownerId,
      prompt,
      rawPrompt,
      scope,
      hasImage: false,
      result,
    });

    ctx.body = {
      data: {
        ...result,
        email: identity.email,
        ownerId: identity.ownerId,
        forceRulesOnly,
      },
    };
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

    const usage = await loadTodayUsage(identity.ownerId);
    const forceRulesOnly =
      REMOTE_AI_ENABLED &&
      usage.imageRemoteCount >= DEFAULT_DAILY_VISION_LIMIT;

    const result = await generateAgriAiReply({
      prompt,
      rawPrompt,
      scope: 'agriculture',
      imageBase64,
      fileName,
      forceRulesOnly,
    });
    await cleanupOldAiLogs(identity.ownerId);
    await createAiLog({
      ownerEmail: identity.email,
      ownerProfileId: identity.ownerId,
      prompt: prompt || 'Fotograf analizi',
      rawPrompt: rawPrompt || 'Fotograf analizi',
      scope: 'agriculture',
      hasImage: true,
      result,
    });

    ctx.body = {
      data: {
        ...result,
        email: identity.email,
        ownerId: identity.ownerId,
        forceRulesOnly,
      },
    };
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
