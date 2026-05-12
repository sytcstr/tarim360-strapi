const UID = 'api::registration-block.registration-block';

const DEFAULT_USER_MESSAGE =
  'Bu hesap icin uyelik islemi gerceklestirilemiyor. Destek ekibiyle iletisime gecin.';

export type RegistrationBlockMatch = {
  id: number | string;
  reasonCode: string;
  userMessage: string;
  matchedBy: 'email' | 'phone' | 'domain';
};

export const normalizeEmail = (value: unknown): string =>
  String(value ?? '').trim().toLowerCase();

export const normalizePhone = (value: unknown): string =>
  String(value ?? '').replace(/\D/g, '');

export const emailDomainOf = (email: string): string => {
  const normalized = normalizeEmail(email);
  const at = normalized.indexOf('@');
  if (at < 0 || at === normalized.length - 1) return '';
  return normalized.substring(at + 1).trim();
};

export const registrationUserMessage = (
  value: unknown,
  fallback: string = DEFAULT_USER_MESSAGE,
): string => {
  const text = String(value ?? '').trim();
  return text.length === 0 ? fallback : text;
};

export const findActiveRegistrationBlock = async (
  strapiRef: any,
  {
    email,
    phone,
  }: {
    email?: unknown;
    phone?: unknown;
  },
): Promise<RegistrationBlockMatch | null> => {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);
  const emailDomain = emailDomainOf(normalizedEmail);

  const rows = await strapiRef.db.query(UID).findMany({
    where: { isActive: true },
    select: [
      'id',
      'email',
      'phone',
      'emailDomain',
      'reasonCode',
      'userMessage',
    ],
  });

  const all = Array.isArray(rows) ? rows : [];
  for (const row of all as Record<string, unknown>[]) {
    const blockEmail = normalizeEmail(row.email);
    const blockPhone = normalizePhone(row.phone);
    const blockDomain = normalizeEmail(row.emailDomain);
    const reasonCode = String(row.reasonCode ?? '').trim().toLowerCase();
    const userMessage = registrationUserMessage(row.userMessage);

    if (normalizedEmail && blockEmail && blockEmail === normalizedEmail) {
      return {
        id: String(row.id ?? ''),
        reasonCode,
        userMessage,
        matchedBy: 'email',
      };
    }

    if (normalizedPhone && blockPhone && blockPhone === normalizedPhone) {
      return {
        id: String(row.id ?? ''),
        reasonCode,
        userMessage,
        matchedBy: 'phone',
      };
    }

    if (emailDomain && blockDomain && blockDomain === emailDomain) {
      return {
        id: String(row.id ?? ''),
        reasonCode,
        userMessage,
        matchedBy: 'domain',
      };
    }
  }

  return null;
};
