import { syncOwnerPremiumFlags } from '../../../../utils/premium-sync';

const PROFILE_SETTING_UID = 'api::profile-setting.profile-setting';

const isPushTokenOnlyMutation = (event: any) => {
  const data = event?.params?.data;
  if (!data || typeof data !== 'object') return false;

  const keys = Object.keys(data as Record<string, unknown>).filter(
    (key) => key !== 'updatedAtClient',
  );
  if (keys.length === 0) return false;

  return keys.every((key) => key === 'fcmTokens' || key === 'profileId');
};

const loadProfileSetting = async (strapiRef: any, id: unknown) => {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) return null;

  return strapiRef.entityService.findOne(PROFILE_SETTING_UID as any, numericId, {
    fields: ['profileId', 'activePremium', 'activePremiumSubscription'],
  });
};

const syncFromEvent = async (event: any) => {
  const resultId =
    event?.result?.id ??
    event?.params?.where?.id ??
    event?.params?.data?.id ??
    null;
  const entry = await loadProfileSetting(strapi, resultId);
  if (!entry) return;
  await syncOwnerPremiumFlags(strapi, entry as Record<string, unknown>);
};

export default {
  async afterCreate(event: any) {
    if (isPushTokenOnlyMutation(event)) return;
    await syncFromEvent(event);
  },

  async afterUpdate(event: any) {
    if (isPushTokenOnlyMutation(event)) return;
    await syncFromEvent(event);
  },
};
