'use strict';

const crypto = require('crypto');

const THREAD_UID = 'api::thread.thread';
const MESSAGE_UID = 'api::message.message';

const pick = (source, keys) => {
  for (const key of keys) {
    const value = source && source[key];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
};

const asData = (ctx) => {
  const body = ctx.request.body || {};
  return body.data && typeof body.data === 'object' ? body.data : body;
};

const cleanEmail = (value) => String(value || '').trim().toLowerCase();
const cleanId = (value) => String(value || '').trim();

const actorForUser = (user) => ({
  email: cleanEmail(user && user.email),
  profileId: cleanId(
    user &&
      (user.profileId ||
        user.ownerProfileId ||
        ownerIdFromEmail(user.email) ||
        user.id),
  ),
  name: cleanId(user && (user.username || user.email || user.id)),
});

const ownerIdFromEmail = (email) => {
  const value = cleanEmail(email);
  if (!value) return '';
  const safe = value.replace(/[^a-z0-9]/g, '_');
  return safe ? `u_${safe}` : '';
};

const actorKey = (profileId, email, name) => {
  const pid = cleanId(profileId);
  if (pid) return `profile:${pid}`;
  const mail = cleanEmail(email);
  if (mail) return `email:${mail}`;
  return `name:${String(name || '').trim().toLowerCase()}`;
};

const inferContextType = (data) => {
  const explicit = pick(data, ['contextType']);
  if (explicit) return explicit;
  const listingId = pick(data, ['listingId']);
  if (listingId.startsWith('processed_') || listingId.startsWith('pp_')) {
    return 'processed_product';
  }
  if (listingId.startsWith('load_') || listingId.startsWith('log_load_')) {
    return 'logistics_load';
  }
  if (listingId || pick(data, ['productId'])) return 'listing';
  return 'general';
};

const inferContextId = (data) =>
  pick(data, [
    'contextId',
    'listingId',
    'productId',
    'logisticsLoadId',
    'loadId',
    'threadId',
  ]);

const normalizeParticipants = (data, user) => {
  const current = actorForUser(user);
  let requesterEmail = cleanEmail(pick(data, ['requesterEmail', 'requestedByEmail']));
  let requesterProfileId = cleanId(pick(data, ['requesterProfileId', 'requestedByProfileId']));
  let requesterName = pick(data, ['requesterName', 'requestedByName']);
  let receiverEmail = cleanEmail(
    pick(data, [
      'receiverEmail',
      'targetEmail',
      'messageReceiverEmail',
      'ownerEmail',
    ]),
  );
  let receiverProfileId = cleanId(
    pick(data, [
      'receiverProfileId',
      'targetProfileId',
      'messageReceiverProfileId',
      'ownerProfileId',
    ]),
  );
  let receiverName = pick(data, ['receiverName', 'targetName', 'ownerName', 'personName']);

  const senderEmail = cleanEmail(pick(data, ['senderEmail'])) || current.email;
  const senderProfileId = cleanId(pick(data, ['senderProfileId'])) || current.profileId;
  const senderName = pick(data, ['senderName']) || current.name;

  if (!requesterEmail && !requesterProfileId) {
    requesterEmail = senderEmail;
    requesterProfileId = senderProfileId;
    requesterName = requesterName || senderName;
  }

  const senderLooksReceiver =
    (receiverEmail && senderEmail && receiverEmail === senderEmail) ||
    (receiverProfileId && senderProfileId && receiverProfileId === senderProfileId);
  if (senderLooksReceiver && (!requesterEmail && !requesterProfileId)) {
    requesterEmail = senderEmail;
    requesterProfileId = senderProfileId;
    requesterName = requesterName || senderName;
  }

  return {
    requesterEmail,
    requesterProfileId,
    requesterName,
    receiverEmail,
    receiverProfileId,
    receiverName,
    senderEmail,
    senderProfileId,
    senderName,
  };
};

const isSamePerson = (aProfile, aEmail, bProfile, bEmail) => {
  const ap = cleanId(aProfile);
  const bp = cleanId(bProfile);
  if (ap && bp && ap === bp) return true;
  const ae = cleanEmail(aEmail);
  const be = cleanEmail(bEmail);
  return !!ae && !!be && ae === be;
};

const senderIsParticipant = (participants) =>
  isSamePerson(
    participants.senderProfileId,
    participants.senderEmail,
    participants.requesterProfileId,
    participants.requesterEmail,
  ) ||
  isSamePerson(
    participants.senderProfileId,
    participants.senderEmail,
    participants.receiverProfileId,
    participants.receiverEmail,
  );

const conversationKeyFor = (data, user) => {
  const p = normalizeParticipants(data, user);
  const a = actorKey(p.requesterProfileId, p.requesterEmail, p.requesterName);
  const b = actorKey(p.receiverProfileId, p.receiverEmail, p.receiverName);
  const sorted = [a, b].sort().join('|');
  const contextType = inferContextType(data);
  const contextId = inferContextId(data);
  return `${sorted}|${contextType}:${contextId}`;
};

const threadIdFor = (data, conversationKey) => {
  const supplied = pick(data, ['threadId', 'conversationId']);
  if (supplied && !supplied.toLowerCase().startsWith('support_')) return supplied;
  return `conv_${crypto.createHash('sha1').update(conversationKey).digest('hex').slice(0, 24)}`;
};

const messageMetadataFor = (data) => {
  const base = data.metadata && typeof data.metadata === 'object' ? { ...data.metadata } : {};
  for (const key of ['messageType', 'offerEvent', 'offerId', 'offerStatus']) {
    const value = pick(data, [key]);
    if (value) base[key] = value;
  }
  return base;
};

const findThread = async (strapi, data, conversationKey, threadId) => {
  const attempts = [
    { conversationKey },
    { threadId },
  ].filter((filters) => Object.values(filters).some(Boolean));
  for (const filters of attempts) {
    const rows = await strapi.entityService.findMany(THREAD_UID, {
      filters,
      limit: 1,
    });
    const row = Array.isArray(rows) ? rows[0] : rows;
    if (row) return row;
  }
  return null;
};

const normalizeThreadData = (data, user) => {
  const p = normalizeParticipants(data, user);
  const contextType = inferContextType(data);
  const contextId = inferContextId(data);
  const conversationKey = conversationKeyFor(data, user);
  const threadId = threadIdFor(data, conversationKey);
  const nowIso = new Date().toISOString();
  return {
    threadId,
    conversationKey,
    contextType,
    contextId,
    listingId: pick(data, ['listingId', 'productId', 'loadId', 'logisticsLoadId']),
    listingTitle: pick(data, ['listingTitle', 'title']),
    listingQtyText: pick(data, ['listingQtyText', 'qtyText']),
    imageUrl: pick(data, ['imageUrl', 'photoUrl', 'mediaUrl']),
    personName: pick(data, ['personName', 'counterpartyName']) || p.receiverName || p.requesterName,
    personCity: pick(data, ['personCity', 'city']),
    personAvatarUrl: pick(data, ['personAvatarUrl', 'avatarUrl']),
    requesterEmail: p.requesterEmail,
    requesterProfileId: p.requesterProfileId,
    requesterName: p.requesterName,
    receiverEmail: p.receiverEmail,
    receiverProfileId: p.receiverProfileId,
    receiverName: p.receiverName,
    lastMessage: pick(data, ['lastMessage', 'message', 'text']),
    lastMessagePreview: pick(data, ['lastMessagePreview', 'lastMessage', 'message', 'text']),
    lastMessageAt: pick(data, ['lastMessageAt', 'sentAt', 'updatedAtClient']) || nowIso,
    lastSenderEmail: cleanEmail(pick(data, ['lastSenderEmail', 'senderEmail'])) || p.senderEmail,
    lastSenderProfileId: cleanId(pick(data, ['lastSenderProfileId', 'senderProfileId'])) || p.senderProfileId,
    lastTimeText: pick(data, ['lastTimeText']),
    unreadCount: Number(data.unreadCount || 0),
    metadata: data.metadata || {},
  };
};

const upsertThread = async (strapi, data, user) => {
  const normalized = normalizeThreadData(data, user);
  const existing = await findThread(
    strapi,
    data,
    normalized.conversationKey,
    normalized.threadId,
  );
  if (existing) {
    return strapi.entityService.update(THREAD_UID, existing.id, {
      data: {
        ...normalized,
        threadId: existing.threadId || normalized.threadId,
        conversationKey: existing.conversationKey || normalized.conversationKey,
      },
    });
  }
  return strapi.entityService.create(THREAD_UID, { data: normalized });
};

const userFilter = (user) => {
  const actor = actorForUser(user);
  const ors = [];
  if (actor.email) {
    ors.push({ requesterEmail: actor.email }, { receiverEmail: actor.email });
  }
  if (actor.profileId) {
    ors.push(
      { requesterProfileId: actor.profileId },
      { receiverProfileId: actor.profileId },
    );
  }
  return ors.length ? { $or: ors } : { id: -1 };
};

export default {
  async mine(ctx) {
    const limit = Math.min(Number(ctx.query?.pagination?.limit || ctx.query?.limit || 220), 300);
    const rows = await strapi.entityService.findMany(THREAD_UID, {
      filters: userFilter(ctx.state.user),
      sort: { lastMessageAt: 'desc' } as any,
      limit,
    });
    ctx.body = { data: rows };
  },

  async myMessages(ctx) {
    const limit = Math.min(Number(ctx.query?.pagination?.limit || ctx.query?.limit || 300), 300);
    const rows = await strapi.entityService.findMany(MESSAGE_UID, {
      filters: userFilter(ctx.state.user),
      sort: { sentAt: 'desc' },
      limit,
    });
    ctx.body = { data: rows };
  },

  async messagesByThread(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized('Giris gerekli.');
    const threadId = String(ctx.params.threadId || '').trim();
    if (!threadId) return ctx.badRequest('threadId gerekli.');
    const threadRows = await strapi.entityService.findMany(THREAD_UID, {
      filters: { $and: [{ threadId }, userFilter(user)] },
      limit: 1,
    });
    const thread = Array.isArray(threadRows) ? threadRows[0] : threadRows;
    if (!thread) return ctx.forbidden('Bu sohbete erisim yok.');
    const rows = await strapi.entityService.findMany(MESSAGE_UID, {
      filters: { threadId },
      sort: { sentAt: 'asc' },
      limit: 300,
    });
    ctx.body = { data: rows };
  },

  async markRead(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized('Giris gerekli.');
    const threadId = String(ctx.params.threadId || '').trim();
    if (!threadId) return ctx.badRequest('threadId gerekli.');

    const threadRows = await strapi.entityService.findMany(THREAD_UID, {
      filters: {
        $and: [
          { threadId },
          userFilter(user),
        ],
      } as any,
      limit: 1,
    });
    const thread = Array.isArray(threadRows) ? threadRows[0] : threadRows;
    if (!thread) return ctx.forbidden('Bu sohbete erisim yok.');

    const actor = actorForUser(user);
    const readAt =
      String((ctx.request?.body || {}).readAt || '').trim() || new Date().toISOString();
    const threadMap = thread as any;
    const currentReceipts =
      threadMap.readReceipts && typeof threadMap.readReceipts === 'object'
        ? { ...threadMap.readReceipts }
        : {};
    currentReceipts[actor.profileId || actor.email || actor.name] = readAt;

    const updatedThread = await strapi.entityService.update(THREAD_UID, thread.id, {
      data: {
        unreadCount: 0,
        lastReadAt: readAt,
        readReceipts: currentReceipts,
      } as any,
    });

    try {
      const messages = await strapi.entityService.findMany(MESSAGE_UID, {
        filters: { threadId },
        limit: 300,
      });
      const list = Array.isArray(messages) ? messages : [];
      await Promise.all(
        list.map((message: any) => {
          const readBy =
            message.readBy && typeof message.readBy === 'object'
              ? { ...message.readBy }
              : {};
          readBy[actor.profileId || actor.email || actor.name] = readAt;
          return strapi.entityService.update(MESSAGE_UID, message.id, {
            data: { readAt, readBy } as any,
          });
        }),
      );
    } catch (e) {
      strapi.log.warn(`Conversation markRead message update failed: ${String(e)}`);
    }

    ctx.body = { data: { ok: true, threadId, readAt, thread: updatedThread } };
  },

  async upsert(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized('Giris gerekli.');
    const data = asData(ctx);
    const p = normalizeParticipants(data, user);
    if (
      isSamePerson(
        p.requesterProfileId,
        p.requesterEmail,
        p.receiverProfileId,
        p.receiverEmail,
      )
    ) {
      return ctx.badRequest('Ayni profil icin sohbet acilamaz.');
    }
    if (!senderIsParticipant(p)) {
      return ctx.forbidden('Sadece sohbet katilimcisi sohbet acabilir.');
    }
    const thread = await upsertThread(strapi, data, user);
    ctx.body = { data: thread };
  },

  async sendMessage(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized('Giris gerekli.');
    const data = asData(ctx);
    const text = pick(data, ['message', 'text', 'body']);
    if (!text) return ctx.badRequest('Mesaj bos olamaz.');
    const p = normalizeParticipants(data, user);
    if (
      isSamePerson(
        p.requesterProfileId,
        p.requesterEmail,
        p.receiverProfileId,
        p.receiverEmail,
      )
    ) {
      return ctx.badRequest('Kullanici kendisine mesaj gonderemez.');
    }
    if (!senderIsParticipant(p)) {
      return ctx.forbidden('Sadece sohbet katilimcisi mesaj gonderebilir.');
    }

    const thread = await upsertThread(
      strapi,
      {
        ...data,
        lastMessage: text,
        lastMessagePreview: text,
        lastSenderEmail: p.senderEmail,
        lastSenderProfileId: p.senderProfileId,
        sentAt: pick(data, ['sentAt']) || new Date().toISOString(),
      },
      user,
    );
    const sentAt = pick(data, ['sentAt']) || new Date().toISOString();
    const message = await strapi.entityService.create(MESSAGE_UID, {
      data: {
        threadId: thread.threadId,
        conversationKey: thread.conversationKey,
        contextType: thread.contextType,
        contextId: thread.contextId,
        listingId: thread.listingId,
        listingTitle: thread.listingTitle,
        message: text,
        text,
        direction: pick(data, ['direction']),
        senderEmail: p.senderEmail,
        senderProfileId: p.senderProfileId,
        senderName: p.senderName,
        requesterEmail: p.requesterEmail,
        requesterProfileId: p.requesterProfileId,
        requesterName: p.requesterName,
        receiverEmail: p.receiverEmail,
        receiverProfileId: p.receiverProfileId,
        receiverName: p.receiverName,
        targetEmail: cleanEmail(pick(data, ['targetEmail', 'messageReceiverEmail'])),
        targetProfileId: cleanId(
          pick(data, ['targetProfileId', 'messageReceiverProfileId']),
        ),
        messageReceiverEmail: cleanEmail(
          pick(data, ['messageReceiverEmail', 'targetEmail']),
        ),
        messageReceiverProfileId: cleanId(
          pick(data, ['messageReceiverProfileId', 'targetProfileId']),
        ),
        sentAt,
        metadata: messageMetadataFor(data),
      },
    });
    ctx.body = { data: message, thread };
  },

  async deleteByThreadId(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized('Giris gerekli.');
    const threadId = String(ctx.params.threadId || '').trim();
    if (!threadId) return ctx.badRequest('threadId gerekli.');

    const threadRows = await strapi.entityService.findMany(THREAD_UID, {
      filters: {
        $and: [
          { threadId },
          userFilter(user),
        ],
      } as any,
      limit: 1,
    });
    const thread = Array.isArray(threadRows) ? threadRows[0] : threadRows;
    if (!thread) return ctx.notFound('Konusma bulunamadi veya erisim yok.');

    const messages = await strapi.entityService.findMany(MESSAGE_UID, {
      filters: { threadId },
      limit: 500,
    });
    const msgList = Array.isArray(messages) ? messages : [];
    await Promise.all(msgList.map((m: any) => strapi.entityService.delete(MESSAGE_UID, m.id)));
    await strapi.entityService.delete(THREAD_UID, thread.id);

    ctx.body = { data: { deleted: true, threadId } };
  },
};
