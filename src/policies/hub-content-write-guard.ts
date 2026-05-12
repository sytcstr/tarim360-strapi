import {
  denyForbidden,
  denyNoIdentity,
  loadEntityByRouteId,
  normalizeEmail,
  readIdentity,
} from '../utils/identity';

const UID = 'api::hub-content.hub-content';

const normalizeKind = (value: unknown): string =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .replace(/[^a-z0-9]+/g, '');

const isFounderOnlyKind = (rawKind: string): boolean => {
  const kind = normalizeKind(rawKind);
  if (!kind) return false;
  if (kind === 'knowledge' || kind.includes('knowledge')) return true;
  if (kind === 'agridata' || kind.includes('agridata')) return true;
  if (kind.includes('bilgi')) return true;
  if (kind.includes('tarimsal') && kind.includes('veri')) return true;
  return false;
};

const parseCsv = (raw: string): string[] =>
  raw
    .split(/[,;\s]+/)
    .map((x) => x.trim())
    .filter((x) => x.length > 0);

const founderEmails = (() => {
  const raw =
    process.env.HUB_CONTENT_FOUNDER_EMAILS ??
    process.env.FOUNDER_EMAILS ??
    '';
  return new Set(parseCsv(raw).map((x) => normalizeEmail(x)).filter(Boolean));
})();

const founderOwnerIds = (() => {
  const raw =
    process.env.HUB_CONTENT_FOUNDER_OWNER_IDS ??
    process.env.FOUNDER_OWNER_IDS ??
    '';
  return new Set(parseCsv(raw));
})();

const isFounder = (email: string, ownerId: string): boolean => {
  if (founderEmails.has(normalizeEmail(email))) return true;
  if (ownerId && founderOwnerIds.has(ownerId)) return true;
  return false;
};

const allowedReactionFields = new Set<string>([
  'likes',
  'comments',
  'commentCount',
  'commentList',
  'lastCommentText',
  'lastCommentAuthor',
  'lastCommentAt',
  'liked',
  'likedByMe',
]);

const isReactionOnlyUpdate = (data: Record<string, unknown>): boolean => {
  const keys = Object.keys(data);
  if (keys.length === 0) return false;
  return keys.every((k) => allowedReactionFields.has(k));
};

export default async (ctx: any, _config: unknown, { strapi }: any) => {
  const method = String(ctx.request?.method ?? '').toUpperCase();
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return true;

  const identity = readIdentity(ctx);
  if (!identity) return denyNoIdentity(ctx);

  const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
  const data = ((body.data ?? {}) as Record<string, unknown>) ?? {};

  let targetKind = String(data.kind ?? '').trim();
  if (!targetKind) {
    const id = String(ctx.params?.id ?? '').trim();
    if (id) {
      const entity = await loadEntityByRouteId(strapi, UID, id, ['kind']);
      targetKind = String(entity?.kind ?? '').trim();
    }
  }

  if (!isFounderOnlyKind(targetKind)) {
    return true;
  }

  if (isFounder(identity.email, identity.ownerId)) {
    return true;
  }

  if ((method === 'PUT' || method === 'PATCH') && isReactionOnlyUpdate(data)) {
    return true;
  }

  return denyForbidden(
    ctx,
    'Bilgi Bankasi ve Tarimsal Veriler iceriklerini sadece kurucu hesaplar yonetebilir.',
  );
};
