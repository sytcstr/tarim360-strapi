const normalizeText = (value: unknown): string => String(value ?? '').trim();

const normalizePreview = (value: string): string => {
  const text = normalizeText(value);
  if (!text) return 'Yeni mesaj alındı.';
  if (text.length <= 220) return text;
  return `${text.substring(0, 217)}...`;
};

const isSamePerson = (
  emailA: string,
  emailB: string,
  profileIdA: string,
  profileIdB: string,
): boolean => {
  if (emailA && emailB && emailA.toLowerCase() === emailB.toLowerCase()) return true;
  if (profileIdA && profileIdB && profileIdA === profileIdB) return true;
  return false;
};

const pushMessageNotification = async (
  strapiRef: any,
  row: Record<string, unknown>,
) => {
  const senderEmail = normalizeText(row.senderEmail).toLowerCase();
  const senderProfileId = normalizeText(row.senderProfileId);
  const receiverEmail = normalizeText(row.receiverEmail).toLowerCase();
  const receiverProfileId = normalizeText(row.receiverProfileId);

  if (!receiverEmail && !receiverProfileId) return;
  if (
    isSamePerson(senderEmail, receiverEmail, senderProfileId, receiverProfileId)
  ) {
    return;
  }

  const messageText = normalizeText(row.message) || normalizeText(row.text);
  const body = normalizePreview(messageText);
  const senderName = normalizeText(row.senderName) || 'Bir kullanıcı';
  const threadId = normalizeText(row.threadId);
  const listingId = normalizeText(row.listingId);
  const baseId =
    normalizeText(row.id) ||
    normalizeText(row.documentId) ||
    String(Date.now());

  await strapiRef.entityService.create('api::notification.notification' as any, {
    data: {
      notificationId: `message_${baseId}`,
      kind: 'message',
      title: 'Yeni Mesaj',
      message: `${senderName}: ${body}`,
      isRead: false,
      targetEmail: receiverEmail,
      targetProfileId: receiverProfileId,
      receiverEmail,
      receiverProfileId,
      senderEmail,
      senderProfileId,
      requesterEmail: normalizeText(row.requesterEmail).toLowerCase(),
      requesterProfileId: normalizeText(row.requesterProfileId),
      threadId,
      listingId,
      createdAtClient: new Date().toISOString(),
    },
  });
};

export default {
  async afterCreate(event: any) {
    const row = (event.result ?? {}) as Record<string, unknown>;
    try {
      await pushMessageNotification(strapi, row);
    } catch (e) {
      strapi.log.warn(`Message notification create failed: ${String(e)}`);
    }
  },
};
