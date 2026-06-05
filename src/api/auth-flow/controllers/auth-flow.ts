import {
  findActiveRegistrationBlock,
  normalizePhone,
  registrationUserMessage,
} from '../../../utils/registration-block';
import { isPremiumActiveFromProfile } from '../../../utils/premium-sync';
import { normalizeFcmTokenList } from '../../../utils/fcm';

const normalizeEmail = (v: unknown) => String(v ?? '').trim().toLowerCase();
const normalizeUsername = (v: unknown) => String(v ?? '').trim().toLowerCase();
const normalizeComparableName = (v: unknown) =>
  String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');

const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const isValidUsername = (value: string) => /^[a-z0-9._]{3,24}$/.test(value);

const generateCode = () =>
  (100000 + Math.floor(Math.random() * 900000)).toString();

const generateTemporaryPassword = () => `T360-${generateCode()}-Aa!`;

async function sendEmail({
  to,
  subject,
  text,
  html,
}: {
  to: string;
  subject: string;
  text: string;
  html: string;
}) {
  const emailPlugin = strapi.plugin('email');
  const emailService = emailPlugin?.service('email');
  if (!emailService?.send) {
    throw new Error('E-posta servisi yapilandirilmamis.');
  }

  await emailService.send({
    to,
    subject,
    text,
    html,
  });
}

async function sendSignupWelcomeEmail({
  to,
  name,
}: {
  to: string;
  name?: string;
}) {
  const safeName = String(name ?? '').trim();
  const greeting = safeName.length == 0 ? 'Merhaba' : `Merhaba ${safeName}`;

  await sendEmail({
    to,
    subject: 'Tarim360 Uyelik Bilgilendirmesi',
    text:
      `${greeting},\n\n` +
      'Tarim360 hesabiniz basariyla olusturuldu.\n' +
      'Uygulamaya giris yaparak ilan, teklif ve pazar ozelliklerini kullanabilirsiniz.\n\n' +
      'Tarim360',
    html:
      `<p>${greeting},</p>` +
      '<p>Tarim360 hesabiniz basariyla olusturuldu.</p>' +
      '<p>Uygulamaya giris yaparak ilan, teklif ve pazar ozelliklerini kullanabilirsiniz.</p>' +
      '<p>Tarim360</p>',
  });
}

async function sendTemporaryPasswordEmail({
  to,
  tempPassword,
}: {
  to: string;
  tempPassword: string;
}) {
  await sendEmail({
    to,
    subject: 'Tarim360 Gecici Sifre',
    text:
      'Tarim360 icin sifre yenileme talebiniz alindi.\n\n' +
      `Gecici sifreniz: ${tempPassword}\n\n` +
      'Guvenlik icin giris sonrasinda sifrenizi degistirin.\n\n' +
      'Tarim360',
    html:
      '<p>Tarim360 icin sifre yenileme talebiniz alindi.</p>' +
      `<p><strong>Gecici sifreniz: ${tempPassword}</strong></p>` +
      '<p>Guvenlik icin giris sonrasinda sifrenizi degistirin.</p>' +
      '<p>Tarim360</p>',
  });
}

export default {
  async premiumOwners(ctx) {
    const pageSize = 500;
    const ownerIds = new Set<string>();

    for (let offset = 0; ; offset += pageSize) {
      const rows = await strapi.db
        .query('api::profile-setting.profile-setting')
        .findMany({
          select: ['profileId', 'activePremium', 'activePremiumSubscription'],
          orderBy: { id: 'asc' },
          offset,
          limit: pageSize,
        } as any);

      const items = Array.isArray(rows) ? rows : [];
      for (const row of items) {
        if (!isPremiumActiveFromProfile(row as Record<string, unknown>)) continue;
        const profileId = String((row as any)?.profileId ?? '').trim();
        if (profileId.length > 0) ownerIds.add(profileId);
      }
      if (items.length < pageSize) break;
    }

    ctx.body = {
      ok: true,
      ownerIds: [...ownerIds],
    };
  },

  async checkRegistration(ctx) {
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const email = normalizeEmail(body.email);
    const phone = normalizePhone(body.phone);
    const username = normalizeUsername(body.username);
    const brandName = normalizeComparableName(body.brandName);
    const profileId = String(body.profileId ?? '').trim();
    const mode = String(body.mode ?? '').trim().toLowerCase();
    const isProfileUpdate = mode === 'profile-update';

    if (!isProfileUpdate && !isEmail(email)) {
      return ctx.badRequest('Gecerli e-posta zorunlu.');
    }

    if (username) {
      if (!isValidUsername(username)) {
        return ctx.badRequest(
          'Kullanici adi 3-24 karakter olmali; sadece kucuk harf, rakam, nokta ve alt cizgi kullanin.',
        );
      }
      const users = await strapi.entityService.findMany(
        'plugin::users-permissions.user',
        {
          filters: { username },
          limit: 2,
        },
      );
      const takenByOther = (Array.isArray(users) ? users : []).some((user: any) => {
        const userEmail = normalizeEmail(user?.email);
        const userProfileId = userEmail ? `u_${userEmail.replace(/[^a-z0-9]/g, '_')}` : '';
        return profileId ? userProfileId !== profileId : true;
      });
      if (takenByOther) {
        ctx.body = {
          ok: true,
          allowed: false,
          reasonCode: 'username_taken',
          matchedBy: 'username',
          message: 'Bu kullanici adi baska bir hesapta kullaniliyor.',
        };
        return;
      }
    }

    if (brandName) {
      const profileRows = await strapi.db.query('api::profile-setting.profile-setting').findMany({
        select: ['id', 'profileId', 'brandName'],
        limit: 500,
      } as any);
      const profileTaken = (Array.isArray(profileRows) ? profileRows : []).some(
        (row: any) =>
          normalizeComparableName(row?.brandName) === brandName &&
          String(row?.profileId ?? '').trim() !== profileId,
      );

      const storeRows = await strapi.db.query('api::seller-store.seller-store').findMany({
        select: ['id', 'ownerId', 'storeName'],
        limit: 500,
      } as any);
      const storeTaken = (Array.isArray(storeRows) ? storeRows : []).some(
        (row: any) =>
          normalizeComparableName(row?.storeName) === brandName &&
          String(row?.ownerId ?? '').trim() !== profileId,
      );

      if (profileTaken || storeTaken) {
        ctx.body = {
          ok: true,
          allowed: false,
          reasonCode: 'brand_name_taken',
          matchedBy: 'brandName',
          message: 'Bu marka adı başka bir hesapta kullanılıyor.',
        };
        return;
      }
    }

    const match = email || phone
      ? await findActiveRegistrationBlock(strapi, {
          email,
          phone,
        })
      : null;

    if (!match) {
      ctx.body = { ok: true, allowed: true };
      return;
    }

    ctx.body = {
      ok: true,
      allowed: false,
      reasonCode: match.reasonCode,
      matchedBy: match.matchedBy,
      message: registrationUserMessage(match.userMessage),
    };
  },

  async updateUsername(ctx) {
    const stateUser = ctx.state?.user as
      | { id?: number | string; username?: string }
      | undefined;
    const currentUserId = Number(stateUser?.id ?? 0);
    if (!currentUserId) return ctx.unauthorized('Oturum gerekli.');

    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const username = normalizeUsername(body.username);

    if (!isValidUsername(username)) {
      return ctx.badRequest(
        'Kullanici adi 3-24 karakter olmali; sadece kucuk harf, rakam, nokta ve alt cizgi kullanin.',
      );
    }

    const matches = await strapi.entityService.findMany(
      'plugin::users-permissions.user',
      {
        filters: { username },
        limit: 1,
      },
    );
    const existing = Array.isArray(matches) ? matches[0] : null;
    if (existing?.id && Number(existing.id) !== currentUserId) {
      return ctx.badRequest('Bu kullanici adi baska bir hesapta kullaniliyor.');
    }

    await strapi.entityService.update(
      'plugin::users-permissions.user',
      currentUserId,
      { data: { username } },
    );

    ctx.body = {
      ok: true,
      username,
    };
  },


  async registerPushToken(ctx) {
    const stateUser = ctx.state?.user as { email?: string } | undefined;
    const email = normalizeEmail(stateUser?.email);
    const profileId = email ? `u_${email.replace(/[^a-z0-9]/g, '_')}` : '';
    if (!profileId) return ctx.unauthorized('Oturum gerekli.');

    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const token = String(body.token ?? '').trim();
    if (!token) return ctx.badRequest('Push token gerekli.');
    try {
      const matches = await strapi.entityService.findMany(
        'api::profile-setting.profile-setting',
        {
          filters: { profileId },
          limit: 1,
        },
      );
      const existingProfile = Array.isArray(matches) ? matches[0] : null;

      const normalizeTokens = (raw: unknown): string[] => {
        const bag = new Set<string>();
        const visit = (value: unknown) => {
          if (value == null) return;
          if (Array.isArray(value)) {
            for (const item of value) visit(item);
            return;
          }
          const text = String(value).trim();
          if (!text) return;
          bag.add(text);
        };
        visit(raw);
        return [...bag];
      };

      const current = normalizeTokens((existingProfile as any)?.fcmTokens);
      const next = [...new Set<string>([...current, token])];

      if ((existingProfile as any)?.id) {
        await strapi.entityService.update(
          'api::profile-setting.profile-setting',
          (existingProfile as any).id,
          {
            data: {
              fcmTokens: next,
              updatedAtClient: new Date().toISOString(),
            },
          },
        );
      } else {
        await strapi.entityService.create(
          'api::profile-setting.profile-setting',
          {
            data: {
              profileId,
              fcmTokens: next,
              updatedAtClient: new Date().toISOString(),
            },
          },
        );
      }

      ctx.body = { ok: true, profileId, tokens: next.length };
    } catch (e) {
      const message = String(e).replace('Error: ', '');
      strapi.log.warn(`registerPushToken failed for ${profileId}: ${message}`);
      ctx.status = 500;
      ctx.body = { ok: false, message: `Push token kaydi basarisiz: ${message}` };
    }
  },

  async unregisterPushToken(ctx) {
    const stateUser = ctx.state?.user as { email?: string } | undefined;
    const email = normalizeEmail(stateUser?.email);
    const profileId = email ? `u_${email.replace(/[^a-z0-9]/g, '_')}` : '';
    if (!profileId) return ctx.unauthorized('Oturum gerekli.');

    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const token = String(body.token ?? '').trim();
    if (!token) return ctx.badRequest('Push token gerekli.');
    try {
      const matches = await strapi.entityService.findMany(
        'api::profile-setting.profile-setting',
        {
          filters: { profileId },
          limit: 1,
        },
      );
      const existingProfile = Array.isArray(matches) ? matches[0] : null;

      if (!(existingProfile as any)?.id) {
        ctx.body = { ok: true, profileId, tokens: 0 };
        return;
      }

      const current = Array.isArray((existingProfile as any).fcmTokens)
        ? ((existingProfile as any).fcmTokens as unknown[])
            .map((item) => String(item ?? '').trim())
            .filter((item) => item.length > 0)
        : [];
      const next = current.filter((item) => item !== token);

      await strapi.entityService.update(
        'api::profile-setting.profile-setting',
        (existingProfile as any).id,
        {
          data: {
            fcmTokens: next,
            updatedAtClient: new Date().toISOString(),
          },
        },
      );

      ctx.body = { ok: true, profileId, tokens: next.length };
    } catch (e) {
      const message = String(e).replace('Error: ', '');
      strapi.log.warn(`unregisterPushToken failed for ${profileId}: ${message}`);
      ctx.status = 500;
      ctx.body = { ok: false, message: `Push token silme basarisiz: ${message}` };
    }
  },
  async requestSignupVerification(ctx) {
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const email = normalizeEmail(body.email);
    const phone = String(body.phone ?? '').trim();

    if (!isEmail(email)) {
      return ctx.badRequest('Gecerli e-posta zorunlu.');
    }

    // Registration code flow is intentionally disabled.
    ctx.body = {
      ok: true,
      email,
      phone,
      message: 'Kayitta dogrulama kodu adimi kapatildi.',
    };
  },

  async verifySignup(ctx) {
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const email = normalizeEmail(body.email);

    if (!isEmail(email)) {
      return ctx.badRequest('Gecerli e-posta zorunlu.');
    }

    // Backward-compatible success response.
    ctx.body = { ok: true, email, verified: true, skipped: true };
  },

  async sendSignupWelcome(ctx) {
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const email = normalizeEmail(body.email);
    const name = String(body.name ?? '').trim();

    if (!isEmail(email)) {
      return ctx.badRequest('Gecerli e-posta zorunlu.');
    }

    try {
      await sendSignupWelcomeEmail({ to: email, name });
    } catch (e) {
      return ctx.badRequest(
        `Uyelik e-postasi gonderilemedi: ${String(e).replace('Error: ', '')}`,
      );
    }

    ctx.body = { ok: true, email };
  },

  async requestPasswordReset(ctx) {
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const identifier = normalizeEmail(body.identifier);

    if (!isEmail(identifier)) {
      return ctx.badRequest('Gecerli e-posta zorunlu.');
    }

    const users = await strapi.entityService.findMany(
      'plugin::users-permissions.user',
      {
        filters: { email: identifier },
        limit: 1,
      },
    );
    const user = Array.isArray(users) ? users[0] : null;
    if (!user?.id) {
      // Prevent user enumeration.
      ctx.body = { ok: true, identifier };
      return;
    }

    const tempPassword = generateTemporaryPassword();

    await strapi.entityService.update(
      'plugin::users-permissions.user',
      user.id,
      { data: { password: tempPassword } },
    );

    try {
      await sendTemporaryPasswordEmail({
        to: identifier,
        tempPassword,
      });
    } catch (e) {
      return ctx.badRequest(
        `Sifre e-postasi gonderilemedi: ${String(e).replace('Error: ', '')}`,
      );
    }

    ctx.body = { ok: true, identifier };
  },

  async resetPassword(ctx) {
    // This endpoint is kept for backward compatibility.
    // Current flow: request-password-reset sends a temporary password by email.
    ctx.body = {
      ok: false,
      message:
        'Bu akista sifre e-posta ile gecici sifre olarak gonderilir. Lutfen "sifremi unuttum" adimini tekrar kullanin.',
    };
  },
};



