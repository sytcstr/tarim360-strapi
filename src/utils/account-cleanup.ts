import type { Core } from '@strapi/strapi';

const HUB_CONTENT_UID = 'api::hub-content.hub-content';

export type AccountCleanupTarget = {
  ownerId?: string;
  email?: string;
};

export type AccountCleanupSummary = {
  hubCommentsRemoved: number;
  farmerQuestionsArchived: number;
  farmerAnswersRemoved: number;
  farmerCommentRowsArchived: number;
  hubRowsUpdated: number;
};

export const normalizeCleanupEmail = (value: unknown) =>
  String(value ?? '').trim().toLowerCase();

export const ownerIdFromCleanupEmail = (email: string) =>
  email ? `u_${email.replace(/[^a-z0-9]/g, '_')}` : '';

const cleanText = (value: unknown) => String(value ?? '').trim();

const normalizeOwnerId = (value: unknown) => cleanText(value);

const parseBodyJson = (value: unknown): Record<string, unknown> => {
  const raw = cleanText(value);
  if (!raw) return {};
  try {
    const decoded = JSON.parse(raw);
    if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
      return decoded as Record<string, unknown>;
    }
  } catch (_) {}
  return {};
};

const isFarmerQuestionKind = (kind: unknown) => {
  const key = cleanText(kind).toLowerCase();
  return (
    key === 'farmerquestion' ||
    key === 'farmer_question' ||
    key === 'ciftcisorusu' ||
    (key.includes('farmer') &&
      key.includes('question') &&
      !key.includes('comment') &&
      !key.includes('answer') &&
      !key.includes('reply'))
  );
};

const isFarmerCommentKind = (kind: unknown) => {
  const key = cleanText(kind).toLowerCase();
  return (
    key === 'farmerquestioncomment' ||
    key === 'farmer_question_comment' ||
    (key.includes('farmer') &&
      (key.includes('comment') ||
        key.includes('answer') ||
        key.includes('reply')))
  );
};

const matchesTarget = (
  source: Record<string, unknown>,
  targetOwnerId: string,
  targetEmail: string,
) => {
  const profileId = normalizeOwnerId(
    source.profileId ??
      source.ownerId ??
      source.ownerProfileId ??
      source.authorProfileId,
  );
  const email = normalizeCleanupEmail(
    source.email ?? source.ownerEmail ?? source.authorEmail,
  );
  return (
    (!!targetOwnerId && profileId === targetOwnerId) ||
    (!!targetEmail && email === targetEmail)
  );
};

const archivePayload = (body: Record<string, unknown>) => {
  const now = new Date().toISOString();
  return {
    state: 'archived',
    body: JSON.stringify({
      ...body,
      deleted: true,
      isDeleted: true,
      archived: true,
      deletedAt: now,
      archivedAt: now,
    }),
  };
};

const answerTime = (answer: Record<string, unknown>) => {
  const raw = cleanText(answer.createdAt ?? answer.time);
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

const buildFarmerConversationText = (
  row: Record<string, unknown>,
  body: Record<string, unknown>,
  answers: Record<string, unknown>[],
) => {
  const authorName = cleanText(body.authorName ?? row.authorName) || 'Kullanici';
  const city = cleanText(body.authorCity ?? row.location) || 'Turkiye';
  const question = cleanText(
    body.detailText ?? body.question ?? row.descShort ?? row.description,
  );
  const lines = [
    `Soru Sahibi: ${authorName} (${city})`,
    'Soru:',
    question,
    '',
    `Yorumlar (${answers.length}):`,
  ];
  const ordered = [...answers].sort((a, b) => answerTime(a) - answerTime(b));
  ordered.forEach((answer, index) => {
    const name = cleanText(answer.name) || 'Kullanici';
    const text = cleanText(answer.text ?? answer.message ?? answer.body);
    if (!text) return;
    lines.push(`${index + 1}) ${name}: ${text}`);
  });
  if (ordered.length === 0) lines.push('- Henuz yorum yok.');
  return lines.join('\n');
};

const commentTime = (comment: Record<string, unknown>) => {
  const raw = cleanText(comment.time ?? comment.createdAt);
  return raw || '';
};

export const cleanupOwnerEmbeddedHubContent = async (
  strapi: Core.Strapi,
  target: AccountCleanupTarget,
): Promise<AccountCleanupSummary> => {
  const targetEmail = normalizeCleanupEmail(target.email);
  const targetOwnerId =
    normalizeOwnerId(target.ownerId) || ownerIdFromCleanupEmail(targetEmail);
  const summary: AccountCleanupSummary = {
    hubCommentsRemoved: 0,
    farmerQuestionsArchived: 0,
    farmerAnswersRemoved: 0,
    farmerCommentRowsArchived: 0,
    hubRowsUpdated: 0,
  };
  if (!targetOwnerId && !targetEmail) return summary;

  const pageSize = 200;
  for (let offset = 0; ; offset += pageSize) {
    const rows = (await strapi.db.query(HUB_CONTENT_UID).findMany({
      select: [
        'id',
        'kind',
        'state',
        'authorName',
        'title',
        'descShort',
        'description',
        'body',
        'content',
        'location',
        'comments',
        'commentCount',
        'commentList',
        'lastCommentText',
        'lastCommentAuthor',
        'lastCommentAt',
      ],
      orderBy: { id: 'asc' },
      offset,
      limit: pageSize,
    } as any)) as Record<string, unknown>[];

    if (!Array.isArray(rows) || rows.length === 0) break;

    for (const row of rows) {
      const id = Number(row.id);
      if (!Number.isInteger(id) || id <= 0) continue;
      const body = parseBodyJson(row.body);
      const kind = row.kind;
      const updateData: Record<string, unknown> = {};
      let rowChanged = false;

      if (isFarmerQuestionKind(kind)) {
        if (matchesTarget(body, targetOwnerId, targetEmail)) {
          Object.assign(updateData, archivePayload(body));
          summary.farmerQuestionsArchived += 1;
          rowChanged = true;
        } else {
          const rawAnswers = Array.isArray(body.answers) ? body.answers : [];
          const keptAnswers = rawAnswers.filter((answer) => {
            if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
              return true;
            }
            return !matchesTarget(
              answer as Record<string, unknown>,
              targetOwnerId,
              targetEmail,
            );
          }) as Record<string, unknown>[];
          const removed = rawAnswers.length - keptAnswers.length;
          if (removed > 0) {
            const nextBody = { ...body, answers: keptAnswers };
            Object.assign(updateData, {
              body: JSON.stringify(nextBody),
              content: buildFarmerConversationText(row, nextBody, keptAnswers),
              comments: keptAnswers.length,
              commentCount: keptAnswers.length,
            });
            summary.farmerAnswersRemoved += removed;
            rowChanged = true;
          }
        }
      } else if (
        isFarmerCommentKind(kind) &&
        matchesTarget(body, targetOwnerId, targetEmail)
      ) {
        Object.assign(updateData, archivePayload(body));
        summary.farmerCommentRowsArchived += 1;
        rowChanged = true;
      }

      const rawComments = Array.isArray(row.commentList)
        ? (row.commentList as unknown[])
        : [];
      if (rawComments.length > 0) {
        const keptComments = rawComments.filter((comment) => {
          if (!comment || typeof comment !== 'object' || Array.isArray(comment)) {
            return true;
          }
          return !matchesTarget(
            comment as Record<string, unknown>,
            targetOwnerId,
            targetEmail,
          );
        }) as Record<string, unknown>[];
        const removed = rawComments.length - keptComments.length;
        if (removed > 0) {
          const last = keptComments[0];
          Object.assign(updateData, {
            commentList: keptComments,
            comments: keptComments.length,
            commentCount: keptComments.length,
            lastCommentText: cleanText(last?.text),
            lastCommentAuthor: cleanText(last?.name),
            lastCommentAt: last ? commentTime(last) : null,
          });
          summary.hubCommentsRemoved += removed;
          rowChanged = true;
        }
      }

      if (!rowChanged) continue;
      await strapi.db.query(HUB_CONTENT_UID).update({
        where: { id },
        data: updateData,
      } as any);
      summary.hubRowsUpdated += 1;
    }

    if (rows.length < pageSize) break;
  }

  return summary;
};
