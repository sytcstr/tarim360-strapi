import { normalizeEmail, ownerIdFromEmail } from '../../../../utils/identity';
import { normalizeFcmTokenList, sendFcmLegacyPush } from '../../../../utils/fcm';

const normalizeText = (value: unknown): string => String(value ?? '').trim();

const isClientSideNotification = (notificationId: string): boolean =>
  notificationId.toLowerCase().startsWith('n_');

const shouldPushFromNotification = (row: Record<string, unknown>): boolean => {
  const notificationId = normalizeText(row.notificationId);
  if (notificationId && isClientSideNotification(notificationId)) return false;
  if (row.isRead === true) return false;
  return true;
};

const resolveTargetProfileId = (row: Record<string, unknown>): string => {
  const profileId = normalizeText(row.targetProfileId);
  if (profileId) return profileId;
  const email = normalizeEmail(row.targetEmail);
  if (!email) return '';
  return ownerIdFromEmail(email);
};

const findProfileSettingsForDelivery = async (
  strapiRef: any,
  row: Record<string, unknown>,
) => {
  const targetProfileId = resolveTargetProfileId(row);
  if (targetProfileId) {
    const one = await strapiRef.db.query('api::profile-setting.profile-setting').findOne({
      where: { profileId: { $eq: targetProfileId } },
      select: ['id', 'profileId', 'fcmTokens'],
    });
    return one ? [one] : [];
  }

  const all = await strapiRef.db.query('api::profile-setting.profile-setting').findMany({
    select: ['id', 'profileId', 'fcmTokens'],
    limit: 5000,
  });
  return Array.isArray(all) ? all : [];
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
  if (nextTokens.length == currentTokens.length) return;

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

export const deliverPush = async (
  strapiRef: any,
  row: Record<string, unknown>,
) => {
  if (!shouldPushFromNotification(row)) return;

  const targets = await findProfileSettingsForDelivery(strapiRef, row);
  if (targets.length === 0) {
    strapiRef.log.warn('FCM push skipped: target profile-setting bulunamadi');
    return;
  }

  const title = normalizeText(row.title) || 'Yeni Bildirim';
  const body = normalizeBody(row);
  const kind = normalizeText(row.kind);
  const notificationId = normalizeText(row.notificationId);

  let totalAttempted = 0;
  let totalSuccess = 0;

  for (const profileSetting of targets) {
    if (!profileSetting || typeof profileSetting !== 'object') continue;
    const targetProfileId = normalizeText(profileSetting.profileId);
    const tokens = normalizeFcmTokenList(profileSetting.fcmTokens);
    if (tokens.length === 0) continue;

    const result = await sendFcmLegacyPush({
      tokens,
      title,
      body,
      data: {
        kind,
        notificationId,
        targetProfileId,
      },
    });

    if (result.skipped) {
      if (result.reason) {
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

  strapiRef.log.info(
    `FCM push sent: attempted=${totalAttempted} success=${totalSuccess} targets=${targets.length}`,
  );
};

export default {
  async afterCreate(event: any) {
    const row = (event.result ?? {}) as Record<string, unknown>;
    try {
      await deliverPush(strapi, row);
    } catch (e) {
      strapi.log.warn(`Notification push delivery failed: ${String(e)}`);
    }
  },
};

