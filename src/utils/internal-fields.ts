/**
 * Fields written only by the logistics admin/moderation endpoints
 * (logistics-admin controller) and read only by the admin screens, which use
 * the /logistics-admin/* endpoints. They must never leave through the public
 * read routes (find/findOne/nearby/byLoad): `moderationNote`/`adminNote` are a
 * moderator's free-text notes.
 */
export const INTERNAL_MODERATION_FIELDS = [
  'moderationNote',
  'adminNote',
  'adminStatus',
  'adminIssueStatus',
] as const;

const stripRow = (row: any): any => {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  for (const field of INTERNAL_MODERATION_FIELDS) delete out[field];
  if (out.attributes && typeof out.attributes === 'object') {
    out.attributes = stripRow(out.attributes);
  }
  return out;
};

/** Accepts a row, an array of rows, or a `{ data }` envelope of either. */
export const stripInternalFields = (payload: any): any => {
  if (Array.isArray(payload)) return payload.map(stripRow);
  if (payload && typeof payload === 'object' && 'data' in payload) {
    return { ...payload, data: stripInternalFields(payload.data) };
  }
  return stripRow(payload);
};
