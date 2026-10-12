import { normalizeEmail, ownerIdFromEmail } from '../../../../utils/identity';
import { normalizeFcmTokenList, sendFcmLegacyPush } from '../../../../utils/fcm';

const normalizeText = (value: unknown): string => String(value ?? '').trim();

const truthy = (value: unknown): boolean =>
  value === true ||
  value === 1 ||
  ['true', '1', 'yes', 'evet'].includes(normalizeText(value).toLowerCase());

const isClientSideLocalNotification = (notificationId: string): boolean =>
  notificationId.toLowerCase().startsWith('n_');

const isBroadcastRow = (row: Record<string, unknown>): boolean => {
  const kind = normalizeText(row.kind || row.type).toLowerCase();
  const audience = normalizeText(row.audience || row.targetAudience).toLowerCase();
  return (
    truthy(row.broadcast) ||
    truthy(row.isBroadcast) ||
    truthy(row.targetAll) ||
    kind === 'broadcast' ||
    kind === 'campaign' ||
    kind === 'announcement' ||
    kind === 'duyuru' ||
    kind === 'kampanya' ||
    audience === 'all' ||
    audience === 'all_users' ||
    audience === 'everyone' ||
    audience === 'global'
  );
};

const shouldPushFromNotification = (row: Record<string, unknown>): boolean => {
  const notificationId = normalizeText(row.notificationId);
  if (truthy(row.skipPush)) return false;
  if (notificationId && isClientSideLocalNotification(notificationId)) return false;
  if (row.isRead === true) return false;
  return true;
};

const resolveTargetProfileId = (row: Record<string, unknown>): string => {
  const candidates = [
    row.targetProfileId,
    row.receiverProfileId,
    row.recipientProfileId,
    row.ownerProfileId,
    row.profileId,
  ];
  for (const value of candidates) {
    const profileId = normalizeText(value);
    if (profileId) return profileId;
  }
  const email = normalizeEmail(row.targetEmail || row.receiverEmail || row.recipientEmail || row.ownerEmail || row.email);
  if (!email) return '';
  return ownerIdFromEmail(email);
};

const targetEmailCandidates = (row: Record<string, unknown>): string[] => {
  const bag = new Set<string>();
  for (const value of [row.targetEmail, row.receiverEmail, row.recipientEmail, row.ownerEmail, row.email]) {
    const email = normalizeEmail(value);
    if (email) bag.add(email);
  }
  return [...bag];
};

const loadAllProfileSettingsWithTokens = async (strapiRef: any) => {
  const rows = await strapiRef.db.query('api::profile-setting.profile-setting').findMany({
    select: ['id', 'profileId', 'fcmTokens'],
    limit: 10000,
  });
  return Array.isArray(rows) ? rows : [];
};

const findProfileSettingsForDelivery = async (
  strapiRef: any,
  row: Record<string, unknown>,
) => {
  if (isBroadcastRow(row)) {
    return loadAllProfileSettingsWithTokens(strapiRef);
  }

  const targetProfileId = resolveTargetProfileId(row);
  if (targetProfileId) {
    const one = await strapiRef.db.query('api::profile-setting.profile-setting').findOne({
      where: { profileId: { $eq: targetProfileId } },
      select: ['id', 'profileId', 'fcmTokens'],
    });
    if (one) return [one];
  }

  const emails = targetEmailCandidates(row);
  for (const email of emails) {
    const profileId = ownerIdFromEmail(email);
    if (!profileId) continue;
    const one = await strapiRef.db.query('api::profile-setting.profile-setting').findOne({
      where: { profileId: { $eq: profileId } },
      select: ['id', 'profileId', 'fcmTokens'],
    });
    if (one) return [one];
  }

  return [];
};

const normalizeBody = (row: Record<string, unknown>): string => {
  const body = normalizeText(row.message);
  if (!body) return 'Yeni bildirim';
  if (body.length <= 220) return body;
  return `${body.substring(0, 217)}...`;
};

const syncInvalidTokens = async (
  strapiRef: any,
  profileSetting: Record<string, unknown>,
  invalidTokens: string[],
) => {
  if (!profileSetting || invalidTokens.length === 0) return;

  const id = profileSetting.id;
  if (typeof id !== 'number') return;

  const currentTokens = normalizeFcmTokenList(profileSetting.fcmTokens);
  if (currentTokens.length === 0) return;

  const invalidSet = new Set(invalidTokens);
  const nextTokens = currentTokens.filter((token) => !invalidSet.has(token));
  if (nextTokens.length === currentTokens.length) return;

  try {
    await strapiRef.db.query('api::profile-setting.profile-setting').update({
      where: { id },
      data: {
        fcmTokens: nextTokens,
        updatedAtClient: new Date().toISOString(),
      },
    });
  } catch (e) {
    strapiRef.log.warn(`FCM token cleanup failed for profile-setting #${id}: ${String(e)}`);
  }
};

const markPushStatus = async (
  strapiRef: any,
  row: Record<string, unknown>,
  data: Record<string, unknown>,
) => {
  const id = row.id;
  if (typeof id !== 'number') return;
  try {
    await strapiRef.db.query('api::notification.notification').update({
      where: { id },
      data,
    });
  } catch (e) {
    strapiRef.log.warn(`Notification push status update failed #${id}: ${String(e)}`);
  }
};

export const deliverPush = async (
  strapiRef: any,
  row: Record<string, unknown>,
) => {
  if (!shouldPushFromNotification(row)) return;

  const targets = await findProfileSettingsForDelivery(strapiRef, row);
  if (targets.length === 0) {
    strapiRef.log.warn('FCM push skipped: target profile-setting bulunamadi');
    await markPushStatus(strapiRef, row, {
      pushStatus: 'skipped',
      pushError: 'target profile-setting bulunamadi',
    });
    return;
  }

  const title = normalizeText(row.title) || 'Yeni Bildirim';
  const body = normalizeBody(row);
  const kind = normalizeText(row.kind || row.type);
  const notificationId = normalizeText(row.notificationId);

  let totalAttempted = 0;
  let totalSuccess = 0;
  let hadAnyRegisteredToken = false;
  const errorNotes: string[] = [];

  for (const profileSetting of targets) {
    if (!profileSetting || typeof profileSetting !== 'object') continue;
    const targetProfileId = normalizeText(profileSetting.profileId);
    const tokens = normalizeFcmTokenList(profileSetting.fcmTokens);
    if (tokens.length === 0) continue;
    hadAnyRegisteredToken = true;

    const result = await sendFcmLegacyPush({
      tokens,
      title,
      body,
      data: {
        kind,
        type: normalizeText(row.type || kind),
        notificationId,
        targetProfileId,
        offerId: normalizeText(row.offerId),
        threadId: normalizeText(row.threadId),
        listingId: normalizeText(row.listingId),
        questionId: normalizeText(row.questionId),
        answerId: normalizeText(row.answerId),
        event: normalizeText(row.event),
        source: normalizeText(row.source),
      },
    });

    if (result.skipped) {
      if (result.reason) {
        errorNotes.push(result.reason);
        strapiRef.log.warn(`FCM push skipped: ${result.reason}`);
      }
      continue;
    }

    totalAttempted += result.attempted;
    totalSuccess += result.success;

    if (result.invalidTokens.length > 0) {
      await syncInvalidTokens(
        strapiRef,
        profileSetting as Record<string, unknown>,
        result.invalidTokens,
      );
    }
  }

  // "Çiftçiden Sorular" audit follow-up (push-reporting accuracy pass):
  // `totalAttempted === 0` used to fall straight into the `'failed'`
  // branch below regardless of WHY nothing was attempted -- no FCM
  // credentials configured (`sendFcmLegacyPush` returns `skipped: true`
  // for every target) and no target having a registered token at all
  // (the per-target `continue` above, which never even calls
  // `sendFcmLegacyPush`) both silently read as a genuine delivery
  // *failure* in `pushStatus`, indistinguishable from "FCM rejected
  // every real attempt". Confirmed concretely: this repo's own local
  // `.env` has zero FCM credentials, so every notification created
  // during any local/test run was unconditionally marked `'failed'`
  // before this fix -- a false signal that would read as a broken
  // integration when it was actually just not configured here.
  // `'skipped'` (already an existing status value, used just above for
  // "no target profile-setting at all") now also covers both of these
  // "nothing was ever actually attempted" cases; `'failed'` is reserved
  // for a genuine attempt FCM itself rejected.
  const pushStatus =
    totalAttempted === 0
      ? 'skipped'
      : totalSuccess === 0
        ? 'failed'
        : totalSuccess < totalAttempted
          ? 'partial'
          : 'sent';
  if (totalAttempted === 0 && !hadAnyRegisteredToken && errorNotes.length === 0) {
    errorNotes.push('hedeflerin hicbirinde kayitli FCM token yok');
  }

  await markPushStatus(strapiRef, row, {
    pushStatus,
    pushError: errorNotes.slice(0, 5).join('\n') || null,
    // `sentAt`/`'sent'` only ever means "the FCM API accepted the
    // request" -- there is no delivery receipt from this API, so neither
    // this field nor `pushStatus` is ever proof the device actually
    // received anything.
    sentAt: totalSuccess > 0 ? new Date().toISOString() : null,
  });

  strapiRef.log.info(
    `FCM push ${pushStatus}: attempted=${totalAttempted} success=${totalSuccess} targets=${targets.length}`,
  );
};

export default {
  async afterCreate(event: any) {
    const row = (event.result ?? {}) as Record<string, unknown>;
    try {
      await deliverPush(strapi, row);
    } catch (e) {
      strapi.log.warn(`Notification push delivery failed: ${String(e)}`);
      await markPushStatus(strapi, row, {
        pushStatus: 'failed',
        pushError: String(e),
      });
    }
  },
};
