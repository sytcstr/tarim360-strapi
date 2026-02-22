const normalizeEmail = (v: unknown) => String(v ?? '').trim().toLowerCase();

const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

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
