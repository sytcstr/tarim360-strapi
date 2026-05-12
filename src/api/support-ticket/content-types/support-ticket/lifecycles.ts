const normalizeText = (value: unknown): string => String(value ?? '').trim();

const normalizeTicketNo = (value: unknown): string => {
  let ticketNo = normalizeText(value);
  if (!ticketNo) return '';
  if (ticketNo.toLowerCase().startsWith('support_')) {
    ticketNo = ticketNo.substring('support_'.length).trim();
  }
  return ticketNo;
};

const normalizeSenderType = (value: unknown): string => {
  const s = normalizeText(value).toLowerCase();
  if (!s) return 'user';
  if (s === 'admin' || s === 'support' || s === 'staff') return 'support';
  if (s === 'system') return 'system';
  if (s === 'outgoing') return 'user';
  return s;
};

const parseMessageTimeMs = (row: Record<string, unknown>): number => {
  const raw =
    normalizeText(row.sentAt) ||
    normalizeText(row.createdAt) ||
    normalizeText(row.updatedAt) ||
    new Date().toISOString();
  const ms = Date.parse(raw);
  if (!Number.isNaN(ms)) return ms;
  return Date.now();
};

const pickMessageText = (row: Record<string, unknown>): string => {
  const message = normalizeText(row.message);
  if (message) return message;
  const text = normalizeText(row.text);
  if (text) return text;
  return '';
};

const pickMessageTicketNo = (row: Record<string, unknown>): string => {
  return (
    normalizeTicketNo(row.ticketNo) ||
    normalizeTicketNo(row.ticketId) ||
    normalizeTicketNo(row.supportTicketId) ||
    normalizeTicketNo(row.threadId)
  );
};

const relationTicketId = (row: Record<string, unknown>): number | null => {
  const raw = (row as any).supportTicket;
  if (typeof raw === 'number') return raw;
  if (raw && typeof raw === 'object' && typeof (raw as any).id === 'number') {
    return (raw as any).id as number;
  }
  return null;
};

const inProgress = new Set<number>();

const rebuildConversationFromMessages = async (
  strapiRef: any,
  ticketRaw: Record<string, unknown>,
) => {
  const ticketId = Number((ticketRaw as any).id ?? 0);
  if (!ticketId) return;
  if (inProgress.has(ticketId)) return;

  const ticketNo = normalizeTicketNo(
    (ticketRaw as any).ticketNo || (ticketRaw as any).id || (ticketRaw as any).documentId,
  );
  const ticketNoLower = ticketNo.toLowerCase();

  const allRows = await strapiRef.db
    .query('api::support-ticket-message.support-ticket-message')
    .findMany();
  const rows = (Array.isArray(allRows) ? allRows : []) as any[];

  const related = rows.filter((r) => {
    const row = r as Record<string, unknown>;
    const byRelation = relationTicketId(row) === ticketId;
    const byTicketNo =
      ticketNoLower.length > 0 &&
      pickMessageTicketNo(row).toLowerCase() === ticketNoLower;
    return byRelation || byTicketNo;
  });

  if (related.length === 0) return;

  const messages = related
    .map((r) => {
      const row = r as Record<string, unknown>;
      const text = pickMessageText(row);
      if (!text) return null;
      const atMs = parseMessageTimeMs(row);
      const atIso = new Date(atMs).toISOString();
      const senderType = normalizeSenderType(row.senderType);
      const senderNameRaw = normalizeText(row.senderName);
      const senderName =
        senderNameRaw ||
        (senderType === 'support'
          ? 'Destek Ekibi'
          : senderType === 'system'
          ? 'Sistem'
          : normalizeText((ticketRaw as any).ownerName) ||
            normalizeText((ticketRaw as any).ownerEmail) ||
            'Kullanici');
      return { text, atMs, atIso, senderType, senderName };
    })
    .filter((x): x is NonNullable<typeof x> => x != null)
    .sort((a, b) => a.atMs - b.atMs);

  if (messages.length === 0) return;

  const last = messages[messages.length - 1];
  const conversation = messages
    .map((m) => `[${m.atIso}] ${m.senderName}: ${m.text}`)
    .join('\n');

  const updateData: Record<string, unknown> = {};
  if (normalizeText((ticketRaw as any).conversation) !== conversation) {
    updateData.conversation = conversation;
  }
  if (normalizeText((ticketRaw as any).lastMessagePreview) !== last.text) {
    updateData.lastMessagePreview = last.text;
  }
  if (normalizeText((ticketRaw as any).lastMessageAt) !== last.atIso) {
    updateData.lastMessageAt = last.atIso;
  }

  const currentStatus = normalizeText((ticketRaw as any).status).toLowerCase();
  if (currentStatus !== 'closed') {
    const nextStatus = last.senderType === 'support' ? 'answered' : 'open';
    if (currentStatus !== nextStatus) {
      updateData.status = nextStatus;
    }
  }

  if (!normalizeText((ticketRaw as any).ownerName)) {
    const firstUser = messages.find((m) => m.senderType === 'user');
    if (firstUser?.senderName) {
      updateData.ownerName = firstUser.senderName;
    }
  }

  if (Object.keys(updateData).length === 0) return;

  inProgress.add(ticketId);
  try {
    await strapiRef.db.query('api::support-ticket.support-ticket').update({
      where: { id: ticketId },
      data: updateData,
    });
  } finally {
    inProgress.delete(ticketId);
  }
};

export default {
  async afterCreate(event: any) {
    const ticket = (event.result ?? {}) as Record<string, unknown>;
    await rebuildConversationFromMessages(strapi, ticket);
  },

  async afterUpdate(event: any) {
    const ticket = (event.result ?? {}) as Record<string, unknown>;
    await rebuildConversationFromMessages(strapi, ticket);
  },
};
