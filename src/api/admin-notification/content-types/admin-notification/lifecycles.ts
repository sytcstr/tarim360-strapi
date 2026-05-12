import { normalizeEmail, ownerIdFromEmail } from '../../../../utils/identity';

const ADMIN_NOTIFICATION_UID = 'api::admin-notification.admin-notification';
const NOTIFICATION_UID = 'api::notification.notification';
const USER_UID = 'plugin::users-permissions.user';

type Recipient = {
  email: string;
  ownerId: string;
};

const normalizeText = (value: unknown): string => String(value ?? '').trim();

const stableToken = (value: string): string => {
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return 'unknown';
  return raw.replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
};

const loadEntry = async (strapiRef: any, id: unknown) => {
  const numericId = Number(id);
  if (!Number.isInteger(numericId) || numericId <= 0) return null;

  return strapiRef.entityService.findOne(ADMIN_NOTIFICATION_UID as any, numericId, {
    fields: [
      'title',
      'message',
      'audience',
      'category',
      'deliveryStatus',
      'sentAt',
      'sentCount',
    ],
    populate: {
      targetUser: {
        fields: ['id', 'email', 'username', 'blocked'],
      },
    },
  });
};

const listAllRecipients = async (strapiRef: any): Promise<Recipient[]> => {
  const rows = await strapiRef.db.query(USER_UID).findMany({
    where: {
      blocked: { $ne: true },
    },
    select: ['email'],
    orderBy: { id: 'asc' },
  } as any);

  const byEmail = new Map<string, Recipient>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const email = normalizeEmail((row as any)?.email);
    if (!email) continue;
    byEmail.set(email, {
      email,
      ownerId: ownerIdFromEmail(email),
    });
  }
  return [...byEmail.values()];
};

const resolveRecipients = async (
  strapiRef: any,
  entry: Record<string, unknown>,
): Promise<Recipient[]> => {
  const audience = normalizeText(entry.audience).toLowerCase();
  if (audience === 'all') {
    return listAllRecipients(strapiRef);
  }

  const targetUser = (entry.targetUser ?? null) as Record<string, unknown> | null;
  const email = normalizeEmail(targetUser?.email);
  if (!email) {
    throw new Error('Tek kullanici seciliyse hedef kullanici zorunludur.');
  }

  return [
    {
      email,
      ownerId: ownerIdFromEmail(email),
    },
  ];
};

const notificationPayloadFor = (
  entryId: number,
  title: string,
  message: string,
  recipient: Recipient,
) => ({
  notificationId: `admin_${entryId}_${stableToken(recipient.ownerId || recipient.email)}`,
  kind: 'broadcast',
  title,
  message,
  isRead: false,
  targetEmail: recipient.email,
  targetProfileId: recipient.ownerId,
  createdAtClient: new Date().toISOString(),
});

const persistDispatchResult = async (
  strapiRef: any,
  id: number,
  patch: Record<string, unknown>,
) => {
  await strapiRef.db.query(ADMIN_NOTIFICATION_UID).update({
    where: { id },
    data: patch,
  } as any);
};

const validateBeforeCreate = (data: Record<string, unknown>) => {
  const audience = normalizeText(data.audience).toLowerCase();
  if (audience === 'single' && !data.targetUser) {
    throw new Error('Tek kullaniciya gonderimde hedef kullanici secmelisin.');
  }
};

const dispatchAdminNotification = async (strapiRef: any, id: number) => {
  const entry = (await loadEntry(strapiRef, id)) as Record<string, unknown> | null;
  if (!entry) return;

  if (normalizeText(entry.deliveryStatus).toLowerCase() === 'sent') return;
  if (normalizeText(entry.sentAt)) return;

  const title = normalizeText(entry.title);
  const message = normalizeText(entry.message);
  if (!title || !message) {
    throw new Error('Bildirim basligi ve mesaji zorunludur.');
  }

  const recipients = await resolveRecipients(strapiRef, entry);
  if (recipients.length === 0) {
    throw new Error('Bildirim gonderilecek kullanici bulunamadi.');
  }

  let sentCount = 0;
  for (const recipient of recipients) {
    await strapiRef.entityService.create(NOTIFICATION_UID as any, {
      data: notificationPayloadFor(id, title, message, recipient),
    });
    sentCount += 1;
  }

  await persistDispatchResult(strapiRef, id, {
    deliveryStatus: 'sent',
    sentAt: new Date().toISOString(),
    sentCount,
    lastError: null,
  });
};

export default {
  async beforeCreate(event: any) {
    const data = ((event.params ?? {}).data ?? {}) as Record<string, unknown>;
    validateBeforeCreate(data);
  },

  async afterCreate(event: any) {
    const id = Number((event.result ?? {}).id);
    if (!Number.isInteger(id) || id <= 0) return;

    try {
      await dispatchAdminNotification(strapi, id);
    } catch (e) {
      await persistDispatchResult(strapi, id, {
        deliveryStatus: 'failed',
        sentAt: null,
        sentCount: 0,
        lastError: String(e),
      });
      strapi.log.warn(`Admin notification dispatch failed for #${id}: ${String(e)}`);
    }
  },
};
