import {
  denyNoIdentity,
  loadEntityByRouteId,
  matchesIdentity,
  mergeScopeOrFilter,
  readIdentity,
} from '../utils/identity';

const UID = 'api::support-ticket-message.support-ticket-message';
const EMAIL_FIELDS = ['requesterEmail', 'senderEmail', 'receiverEmail'];
const PROFILE_FIELDS = [
  'requesterProfileId',
  'senderProfileId',
  'receiverProfileId',
];

const normalizeTicketNo = (value: unknown) => {
  let v = String(value ?? '').trim();
  if (!v) return '';
  const lower = v.toLowerCase();
  if (lower.startsWith('support_')) {
    v = v.substring('support_'.length).trim();
  }
  return v;
};

const extractTicketNoFromFilters = (filters: unknown) => {
  if (!filters || typeof filters != 'object') return '';
  const source = filters as Record<string, unknown>;
  for (const key of ['ticketId', 'ticketNo', 'supportTicketId', 'threadId']) {
    const raw = source[key];
    if (raw == null) continue;
    if (typeof raw == 'string' || typeof raw == 'number') {
      const out = normalizeTicketNo(raw);
      if (out.length > 0) return out;
      continue;
    }
    if (typeof raw == 'object') {
      const obj = raw as Record<string, unknown>;
      const v = obj['$eq'] ?? obj['$eqi'];
      const out = normalizeTicketNo(v);
      if (out.length > 0) return out;
    }
  }
  return '';
};

const canAccessTicketNo = async (
  strapi: any,
  identity: { email: string; ownerId: string },
  ticketNo: string,
) => {
  if (!ticketNo) return false;
  const entity = await strapi.db.query('api::support-ticket.support-ticket').findOne({
    where: {
      ticketNo: { $eq: ticketNo },
      $or: [
        { ownerEmail: { $eq: identity.email } },
        { ownerProfileId: { $eq: identity.ownerId } },
      ],
    },
    select: ['id'],
  });
  return !!entity;
};

export default async (ctx: any, _config: unknown, { strapi }: any) => {
  const identity = readIdentity(ctx);
  if (!identity) return denyNoIdentity(ctx);

  const method = String(ctx.request?.method ?? '').toUpperCase();
  const id = String(ctx.params?.id ?? '').trim();

  if (method === 'GET' && !id) {
    const ticketNo = extractTicketNoFromFilters(ctx.query?.filters);
    if (ticketNo.length > 0) {
      const ok = await canAccessTicketNo(strapi, identity, ticketNo);
      if (!ok) {
        ctx.forbidden('Bu destek talebine erisim yetkin yok.');
        return false;
      }
      return true;
    }

    mergeScopeOrFilter(ctx, [
      { requesterEmail: { $eq: identity.email } },
      { requesterProfileId: { $eq: identity.ownerId } },
      { senderEmail: { $eq: identity.email } },
      { senderProfileId: { $eq: identity.ownerId } },
      { receiverEmail: { $eq: identity.email } },
      { receiverProfileId: { $eq: identity.ownerId } },
    ]);
    return true;
  }

  if (method === 'POST') {
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const data = (body.data ?? {}) as Record<string, unknown>;

    const requesterEmail = String(data.requesterEmail ?? '').trim().toLowerCase();
    const requesterProfileId = String(data.requesterProfileId ?? '').trim();
    if (requesterEmail && requesterEmail !== identity.email) {
      ctx.forbidden('Baska kullanici adina destek mesaji gonderemezsiniz.');
      return false;
    }
    if (requesterProfileId && requesterProfileId !== identity.ownerId) {
      ctx.forbidden('Destek mesaji profil bilgisi aktif oturumla uyusmuyor.');
      return false;
    }

    const senderType = String(data.senderType ?? '').trim().toLowerCase();
    if (!senderType || senderType === 'user' || senderType === 'outgoing') {
      data.senderType = 'user';
      data.senderEmail = identity.email;
      data.senderProfileId = identity.ownerId;
    }
    data.requesterEmail = identity.email;
    data.requesterProfileId = identity.ownerId;

    body.data = data;
    ctx.request.body = body;
    return true;
  }

  if (id) {
    const entity = await loadEntityByRouteId(strapi, UID, id, [
      ...EMAIL_FIELDS,
      ...PROFILE_FIELDS,
    ]);
    const allowed = matchesIdentity(
      entity,
      identity,
      EMAIL_FIELDS,
      PROFILE_FIELDS,
    );
    if (allowed) return true;

    const ticketNo = normalizeTicketNo(
      entity?.ticketNo ?? entity?.ticketId ?? entity?.supportTicketId ?? entity?.threadId,
    );
    const byTicket = ticketNo.length > 0
      ? await canAccessTicketNo(strapi, identity, ticketNo)
      : false;
    if (!byTicket) {
      ctx.forbidden('Bu destek mesajina erisim yetkin yok.');
      return false;
    }
  }

  return true;
};
