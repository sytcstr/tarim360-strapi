import type { Core } from '@strapi/strapi';

type PermissionLeaf = {
  enabled: boolean;
  policy?: string;
};

type PermissionsTree = Record<
  string,
  {
    controllers: Record<string, Record<string, PermissionLeaf>>;
  }
>;

const enableAction = (permissions: PermissionsTree, actionId: string) => {
  const parts = actionId.split('.');
  if (parts.length < 3) return;
  const [typeName, controllerName, actionName] = parts;
  const node = permissions[typeName]?.controllers?.[controllerName]?.[actionName];
  if (!node) return;
  permissions[typeName].controllers[controllerName][actionName] = {
    ...node,
    enabled: true,
  };
};

const enableMany = (permissions: PermissionsTree, actionIds: string[]) => {
  for (const id of actionIds) {
    enableAction(permissions, id);
  }
};

const publicActions: string[] = [
  // Auth basics
  'plugin::users-permissions.auth.callback',
  'plugin::users-permissions.auth.register',
  'plugin::users-permissions.auth.forgotPassword',
  'plugin::users-permissions.auth.resetPassword',
  'plugin::users-permissions.auth.refresh',

  // Public reads
  'api::listing.listing.find',
  'api::listing.listing.findOne',
  'api::ad.ad.find',
  'api::ad.ad.findOne',
  'api::hub-content.hub-content.find',
  'api::hub-content.hub-content.findOne',

  // Custom auth-flow endpoints
  'api::auth-flow.auth-flow.requestSignupVerification',
  'api::auth-flow.auth-flow.verifySignup',
  'api::auth-flow.auth-flow.sendSignupWelcome',
  'api::auth-flow.auth-flow.requestPasswordReset',
  'api::auth-flow.auth-flow.resetPassword',
];

const authenticatedActions: string[] = [
  'plugin::users-permissions.user.me',
  'plugin::users-permissions.auth.logout',
  'plugin::users-permissions.auth.changePassword',

  // Upload (listing/ad image uploads)
  'plugin::upload.content-api.upload',
  'plugin::upload.content-api.find',
  'plugin::upload.content-api.findOne',
  'plugin::upload.content-api.destroy',

  // Listing
  'api::listing.listing.create',
  'api::listing.listing.find',
  'api::listing.listing.findOne',
  'api::listing.listing.update',
  'api::listing.listing.delete',

  // Ad
  'api::ad.ad.create',
  'api::ad.ad.find',
  'api::ad.ad.findOne',
  'api::ad.ad.update',
  'api::ad.ad.delete',

  // Offer
  'api::offer.offer.create',
  'api::offer.offer.find',
  'api::offer.offer.findOne',
  'api::offer.offer.update',
  'api::offer.offer.delete',

  // Message
  'api::message.message.create',
  'api::message.message.find',
  'api::message.message.findOne',
  'api::message.message.update',
  'api::message.message.delete',

  // Thread
  'api::thread.thread.create',
  'api::thread.thread.find',
  'api::thread.thread.findOne',
  'api::thread.thread.update',
  'api::thread.thread.delete',

  // Notification
  'api::notification.notification.create',
  'api::notification.notification.find',
  'api::notification.notification.findOne',
  'api::notification.notification.update',
  'api::notification.notification.delete',

  // Hub content
  'api::hub-content.hub-content.create',
  'api::hub-content.hub-content.find',
  'api::hub-content.hub-content.findOne',
  'api::hub-content.hub-content.update',
  'api::hub-content.hub-content.delete',

  // Profile settings
  'api::profile-setting.profile-setting.create',
  'api::profile-setting.profile-setting.find',
  'api::profile-setting.profile-setting.findOne',
  'api::profile-setting.profile-setting.update',
  'api::profile-setting.profile-setting.delete',
];

const syncUsersPermissionsRoleConfig = async (strapi: Core.Strapi) => {
  const roleService = strapi.plugin('users-permissions').service('role');
  const roles = await strapi.db.query('plugin::users-permissions.role').findMany();
  const publicRole = roles.find((r: any) => r.type === 'public');
  const authenticatedRole = roles.find((r: any) => r.type === 'authenticated');

  if (publicRole?.id) {
    const current = await roleService.findOne(publicRole.id);
    const permissions = current.permissions as PermissionsTree;
    enableMany(permissions, publicActions);
    await roleService.updateRole(publicRole.id, {
      permissions,
    });
  }

  if (authenticatedRole?.id) {
    const current = await roleService.findOne(authenticatedRole.id);
    const permissions = current.permissions as PermissionsTree;
    enableMany(permissions, authenticatedActions);
    await roleService.updateRole(authenticatedRole.id, {
      permissions,
    });
  }

  const pluginStore = strapi.store({ type: 'plugin', name: 'users-permissions' });
  const advanced = (await pluginStore.get({ key: 'advanced' })) as Record<string, unknown> | undefined;
  await pluginStore.set({
    key: 'advanced',
    value: {
      ...(advanced ?? {}),
      allow_register: true,
      email_confirmation: false,
      default_role: 'authenticated',
      unique_email: true,
    },
  });
};

const normalizeText = (v: unknown) => (v ?? '').toString().trim().toLowerCase();

const deleteMalformedOfferMessageThreadData = async (strapi: Core.Strapi) => {
  const isEmpty = (v: unknown) => (v ?? '').toString().trim() === '';

  // Offer: hem requester hem receiver bilgisi bos ise sil.
  try {
    const offers = await strapi.db.query('api::offer.offer').findMany();
    const all = Array.isArray(offers) ? offers : [];
    for (const row of all as any[]) {
      const reqEmail = normalizeText(row.requesterEmail);
      const reqProfile = normalizeText(row.requesterProfileId);
      const recvEmail = normalizeText(row.receiverEmail);
      const recvProfile = normalizeText(row.receiverProfileId);
      const malformed =
        isEmpty(reqEmail) &&
        isEmpty(reqProfile) &&
        isEmpty(recvEmail) &&
        isEmpty(recvProfile);
      if (!malformed) continue;
      if (!row.id) continue;
      try {
        await strapi.db.query('api::offer.offer').delete({ where: { id: row.id } });
      } catch (_) {}
    }
  } catch (_) {}

  // Message: threadId yoksa veya iki taraf kimliği tamamen boşsa sil.
  try {
    const messages = await strapi.db.query('api::message.message').findMany();
    const all = Array.isArray(messages) ? messages : [];
    for (const row of all as any[]) {
      const threadId = normalizeText(row.threadId);
      const reqEmail = normalizeText(row.requesterEmail);
      const reqProfile = normalizeText(row.requesterProfileId);
      const recvEmail = normalizeText(row.receiverEmail);
      const recvProfile = normalizeText(row.receiverProfileId);
      const malformed =
        isEmpty(threadId) ||
        (isEmpty(reqEmail) &&
            isEmpty(reqProfile) &&
            isEmpty(recvEmail) &&
            isEmpty(recvProfile));
      if (!malformed) continue;
      if (!row.id) continue;
      try {
        await strapi.db.query('api::message.message').delete({ where: { id: row.id } });
      } catch (_) {}
    }
  } catch (_) {}

  // Thread: threadId yoksa veya iki taraf kimliği tamamen boşsa sil.
  try {
    const threads = await strapi.db.query('api::thread.thread').findMany();
    const all = Array.isArray(threads) ? threads : [];
    for (const row of all as any[]) {
      const threadId = normalizeText(row.threadId);
      const reqEmail = normalizeText(row.requesterEmail);
      const reqProfile = normalizeText(row.requesterProfileId);
      const recvEmail = normalizeText(row.receiverEmail);
      const recvProfile = normalizeText(row.receiverProfileId);
      const malformed =
        isEmpty(threadId) ||
        (isEmpty(reqEmail) &&
            isEmpty(reqProfile) &&
            isEmpty(recvEmail) &&
            isEmpty(recvProfile));
      if (!malformed) continue;
      if (!row.id) continue;
      try {
        await strapi.db.query('api::thread.thread').delete({ where: { id: row.id } });
      } catch (_) {}
    }
  } catch (_) {}
};

export default {
  register() {},

  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    await syncUsersPermissionsRoleConfig(strapi);
    const cleanupEnabled =
      (process.env.CLEANUP_MALFORMED_TEST_DATA ?? '').toLowerCase() === 'true';
    if (cleanupEnabled) {
      await deleteMalformedOfferMessageThreadData(strapi);
      strapi.log.info(
        'Malformed offer/message/thread cleanup executed (CLEANUP_MALFORMED_TEST_DATA=true).',
      );
    } else {
      strapi.log.info(
        'Malformed data cleanup skipped (set CLEANUP_MALFORMED_TEST_DATA=true to run once).',
      );
    }
    strapi.log.info('Users & Permissions roles synced from bootstrap.');
  },
};
