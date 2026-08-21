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
  const raw = normalizeText(value).toLowerCase();
  if (!raw) return '';
  if (raw === 'admin' || raw === 'staff' || raw === 'support') return 'support';
  if (raw === 'user' || raw === 'outgoing') return 'user';
  if (raw === 'system') return 'system';
  return raw;
};

const asObject = (input: unknown): Record<string, unknown> | null => {
  if (!input || typeof input !== 'object') return null;
  return input as Record<string, unknown>;
};

const firstFromRelationArray = (value: unknown): unknown => {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value[0];
};

type TicketRef = { id?: number; documentId?: string; ticketNo?: string };

const extractRelationRef = (input: unknown): TicketRef => {
  if (input == null) return {};

  if (typeof input === 'number') return { id: Math.trunc(input) };
  if (typeof input === 'string') {
    const text = normalizeText(input);
    if (!text) return {};
    if (/^\d+$/.test(text)) return { id: Number.parseInt(text, 10) };
    if (/^(DST-|support_)/i.test(text)) return { ticketNo: normalizeTicketNo(text) };
    return { documentId: text };
  }

  const map = asObject(input);
  if (!map) return {};

  const directId = map.id;
  if (typeof directId === 'number') return { id: Math.trunc(directId) };
  if (typeof directId === 'string' && /^\d+$/.test(directId.trim())) {
    return { id: Number.parseInt(directId.trim(), 10) };
  }

  const directDocumentId = normalizeText(map.documentId);
  if (directDocumentId) return { documentId: directDocumentId };

  const directTicketNo = normalizeTicketNo(map.ticketNo);
  if (directTicketNo) return { ticketNo: directTicketNo };

  const connectFirst = firstFromRelationArray(map.connect);
  if (connectFirst != null) return extractRelationRef(connectFirst);

  const setFirst = firstFromRelationArray(map.set);
  if (setFirst != null) return extractRelationRef(setFirst);

  return {};
};

const resolveTicketNo = (data: Record<string, unknown>): string => {
  const fromTicketNo = normalizeTicketNo(data.ticketNo);
  if (fromTicketNo) return fromTicketNo;
  const fromTicketId = normalizeTicketNo(data.ticketId);
  if (fromTicketId) return fromTicketId;
  const fromSupportTicketId = normalizeTicketNo(data.supportTicketId);
  if (fromSupportTicketId) return fromSupportTicketId;
  const fromThreadId = normalizeTicketNo(data.threadId);
  if (fromThreadId) return fromThreadId;
  const relationRef = extractRelationRef(data.supportTicket);
  if (relationRef.ticketNo) return relationRef.ticketNo;
  return '';
};

const setIfEmpty = (
  data: Record<string, unknown>,
  key: string,
  value: unknown,
) => {
  if (normalizeText(data[key])) return;
  if (!normalizeText(value)) return;
  data[key] = value;
};

const syncMessageTextFields = (data: Record<string, unknown>) => {
  const message = normalizeText(data.message);
  const text = normalizeText(data.text);
  if (!message && text) data.message = text;
  if (!text && message) data.text = message;
};

const TICKET_SELECT = [
  'id',
  'documentId',
  'ticketNo',
  'ownerEmail',
  'ownerName',
  'ownerProfileId',
  'status',
  'conversation',
];

const findSupportTicketByNo = async (strapiRef: any, ticketNo: string) => {
  if (!ticketNo) return null;
  return strapiRef.db.query('api::support-ticket.support-ticket').findOne({
    where: { ticketNo: { $eq: ticketNo } },
    select: TICKET_SELECT,
  });
};

const findSupportTicketByRelationInput = async (
  strapiRef: any,
  relationInput: unknown,
) => {
  const ref = extractRelationRef(relationInput);

  if (ref.id != null) {
    const byId = await strapiRef.db.query('api::support-ticket.support-ticket').findOne({
      where: { id: ref.id },
      select: TICKET_SELECT,
    });
    if (byId) return byId;
  }

  if (ref.documentId) {
    const byDoc = await strapiRef.db.query('api::support-ticket.support-ticket').findOne({
      where: { documentId: { $eq: ref.documentId } },
      select: TICKET_SELECT,
    });
    if (byDoc) return byDoc;
  }

  if (ref.ticketNo) {
    return findSupportTicketByNo(strapiRef, ref.ticketNo);
  }

  return null;
};

const hydrateIdentityFieldsFromTicket = (
  data: Record<string, unknown>,
  ticket: any,
) => {
  if (!ticket) return;

  setIfEmpty(data, 'requesterEmail', ticket.ownerEmail);
  setIfEmpty(data, 'requesterProfileId', ticket.ownerProfileId);
  setIfEmpty(data, 'receiverEmail', data.requesterEmail ?? ticket.ownerEmail);
  setIfEmpty(
    data,
    'receiverProfileId',
    data.requesterProfileId ?? ticket.ownerProfileId,
  );
};

const normalizeMessagePayload = async (
  strapiRef: any,
  data: Record<string, unknown>,
) => {
  let ticket = await findSupportTicketByRelationInput(strapiRef, data.supportTicket);
  let ticketNo = resolveTicketNo(data);

  if (!ticketNo && ticket?.ticketNo) {
    ticketNo = normalizeTicketNo(ticket.ticketNo);
  }
  if (!ticket && ticketNo) {
    ticket = await findSupportTicketByNo(strapiRef, ticketNo);
  }

  if (ticketNo) {
    data.ticketNo = ticketNo;
    data.ticketId = ticketNo;
    data.supportTicketId = ticketNo;
  }
  if (ticket?.id != null) {
    data.supportTicket = ticket.id;
  }

  syncMessageTextFields(data);
  setIfEmpty(data, 'sentAt', new Date().toISOString());
  hydrateIdentityFieldsFromTicket(data, ticket);

  const senderType = normalizeSenderType(data.senderType) || 'support';
  data.senderType = senderType;

  if (senderType === 'support') {
    setIfEmpty(data, 'senderName', 'Destek Ekibi');
    setIfEmpty(data, 'senderEmail', 'support@tarim360.app');
    setIfEmpty(data, 'senderProfileId', 'support_team');
  } else if (senderType === 'user') {
    setIfEmpty(data, 'senderEmail', data.requesterEmail);
    setIfEmpty(data, 'senderProfileId', data.requesterProfileId);
  }
};

const syncTicketSummaryFromMessage = async (
  strapiRef: any,
  row: Record<string, unknown>,
  options: { appendConversation: boolean },
) => {
  let ticketNo = resolveTicketNo(row);
  let ticket = ticketNo
    ? await findSupportTicketByNo(strapiRef, ticketNo)
    : null;

  if (!ticket) {
    ticket = await findSupportTicketByRelationInput(strapiRef, row.supportTicket);
    if (!ticketNo && ticket?.ticketNo) {
      ticketNo = normalizeTicketNo(ticket.ticketNo);
    }
  }
  if (!ticket?.id) return;

  const senderType = normalizeSenderType(row.senderType);
  const sentAt =
    normalizeText(row.sentAt) ||
    normalizeText(row.createdAt) ||
    new Date().toISOString();
  const message = normalizeText(row.message) || normalizeText(row.text);
  const senderNameRaw = normalizeText(row.senderName);
  const senderName =
    senderNameRaw ||
    (senderType === 'support'
      ? 'Destek Ekibi'
      : senderType === 'system'
      ? 'Sistem'
      : normalizeText(ticket.ownerName) || normalizeText(ticket.ownerEmail) || 'Kullanici');

  const updateData: Record<string, unknown> = { lastMessageAt: sentAt };
  if (message) updateData.lastMessagePreview = message;
  if (options.appendConversation && message) {
    const previousConversation = normalizeText(ticket.conversation);
    const line = `[${sentAt}] ${senderName}: ${message}`;
    updateData.conversation =
      previousConversation.length === 0
        ? line
        : `${previousConversation}\n${line}`;
  }

  const currentStatus = normalizeText(ticket.status).toLowerCase();
  if (currentStatus !== 'closed') {
    if (senderType === 'support') updateData.status = 'answered';
    if (senderType === 'user') updateData.status = 'open';
  }

  await strapiRef.db.query('api::support-ticket.support-ticket').update({
    where: { id: ticket.id },
    data: updateData,
  });
};

const pushSupportReplyNotification = async (
  strapiRef: any,
  row: Record<string, unknown>,
) => {
  const senderType = normalizeSenderType(row.senderType);
  if (senderType !== 'support') return;

  const ticketNo = normalizeTicketNo(
    row.ticketNo ?? row.ticketId ?? row.supportTicketId ?? row.threadId,
  );
  const targetEmail = normalizeText(row.requesterEmail);
  const targetProfileId = normalizeText(row.requesterProfileId);
  if (!targetEmail && !targetProfileId) return;

  const text = normalizeText(row.message) || normalizeText(row.text);
  if (!text) return;

  const title = 'Destek Yanıtı';
  const body = ticketNo ? `${ticketNo}: ${text}` : text;
  const nowIso = new Date().toISOString();
  const baseId = normalizeText(row.id) || nowIso;
  const notificationId = `support_reply_${baseId}`;

  try {
    await strapiRef.entityService.create('api::notification.notification' as any, {
      data: {
        notificationId,
        kind: 'support_reply',
        title,
        message: body,
        isRead: false,
        targetEmail,
        targetProfileId,
        createdAtClient: nowIso,
      },
    });
  } catch (e) {
    strapiRef.log.warn(`Support reply notification create failed: ${String(e)}`);
  }
};

export default {
  async beforeCreate(event: any) {
    const data = (event.params?.data ?? {}) as Record<string, unknown>;
    await normalizeMessagePayload(strapi, data);
    event.params.data = data;
  },

  async beforeUpdate(event: any) {
    const data = (event.params?.data ?? {}) as Record<string, unknown>;
    await normalizeMessagePayload(strapi, data);
    event.params.data = data;
  },

  async afterCreate(event: any) {
    const row = (event.result ?? {}) as Record<string, unknown>;
    await syncTicketSummaryFromMessage(strapi, row, { appendConversation: true });
    await pushSupportReplyNotification(strapi, row);
  },

  async afterUpdate(event: any) {
    const row = (event.result ?? {}) as Record<string, unknown>;
    await syncTicketSummaryFromMessage(strapi, row, { appendConversation: false });
  },
};
