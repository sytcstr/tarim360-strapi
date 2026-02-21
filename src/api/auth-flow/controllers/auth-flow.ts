type CodeRecord = {
  code: string;
  expiresAt: number;
};

const signupCodes = new Map<string, CodeRecord>();
const resetCodes = new Map<string, CodeRecord>();

const CODE_TTL_MS = 10 * 60 * 1000;

const normalizeEmail = (v: unknown) => String(v ?? '').trim().toLowerCase();
const normalizeCode = (v: unknown) => String(v ?? '').trim();

const generateCode = () =>
  (100000 + Math.floor(Math.random() * 900000)).toString();

const isEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const codeExpired = (entry?: CodeRecord) =>
  !entry || !entry.code || entry.expiresAt < Date.now();

async function sendCodeEmail({
  to,
  subject,
  code,
  purpose,
}: {
  to: string;
  subject: string;
  code: string;
  purpose: string;
}) {
  const emailPlugin = strapi.plugin('email');
  const emailService = emailPlugin?.service('email');
  if (!emailService?.send) {
    throw new Error('E-posta servisi yapılandırılmamış.');
  }

  await emailService.send({
    to,
    subject,
    text: `Tarım360 ${purpose} kodunuz: ${code}\nKod 10 dakika geçerlidir.`,
    html: `<p>Tarım360 ${purpose} kodunuz: <strong>${code}</strong></p><p>Kod 10 dakika geçerlidir.</p>`,
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

    const code = generateCode();
    signupCodes.set(email, { code, expiresAt: Date.now() + CODE_TTL_MS });

    try {
      await sendCodeEmail({
        to: email,
        subject: 'Tarım360 Kayıt Doğrulama Kodu',
        code,
        purpose: 'kayıt doğrulama',
      });
    } catch (e) {
      return ctx.badRequest(
        `Dogrulama e-postasi gonderilemedi: ${String(e).replace('Error: ', '')}`,
      );
    }

    ctx.body = {
      ok: true,
      email,
      phone,
      message: 'Dogrulama kodu e-posta adresinize gonderildi.',
    };
  },

  async verifySignup(ctx) {
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const email = normalizeEmail(body.email);
    const emailCode = normalizeCode(body.emailCode);
    if (!isEmail(email)) {
      return ctx.badRequest('Gecerli e-posta zorunlu.');
    }
    if (!emailCode) {
      return ctx.badRequest('E-posta dogrulama kodu zorunlu.');
    }

    const entry = signupCodes.get(email);
    if (codeExpired(entry)) {
      signupCodes.delete(email);
      return ctx.badRequest('Dogrulama kodu suresi dolmus. Kodu yenileyin.');
    }
    if (entry.code !== emailCode) {
      return ctx.badRequest('E-posta dogrulama kodu hatali.');
    }

    signupCodes.delete(email);
    ctx.body = { ok: true, email, verified: true };
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
      // User enumeration onlenir: yine basarili don.
      ctx.body = { ok: true, identifier };
      return;
    }

    const code = generateCode();
    resetCodes.set(identifier, { code, expiresAt: Date.now() + CODE_TTL_MS });

    try {
      await sendCodeEmail({
        to: identifier,
        subject: 'Tarım360 Sifre Sifirlama Kodu',
        code,
        purpose: 'sifre sifirlama',
      });
    } catch (e) {
      return ctx.badRequest(
        `Sifirlama e-postasi gonderilemedi: ${String(e).replace('Error: ', '')}`,
      );
    }

    ctx.body = { ok: true, identifier };
  },

  async resetPassword(ctx) {
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const identifier = normalizeEmail(body.identifier);
    const code = normalizeCode(body.code);
    const newPassword = String(body.newPassword ?? '');

    if (!isEmail(identifier)) {
      return ctx.badRequest('Gecerli e-posta zorunlu.');
    }
    if (!code) {
      return ctx.badRequest('code zorunlu.');
    }
    if (newPassword.length < 6) {
      return ctx.badRequest('newPassword en az 6 karakter olmali.');
    }

    const entry = resetCodes.get(identifier);
    if (codeExpired(entry)) {
      resetCodes.delete(identifier);
      return ctx.badRequest('Sifirlama kodu suresi dolmus. Kodu yenileyin.');
    }
    if (entry.code !== code) {
      return ctx.badRequest('Sifirlama kodu hatali.');
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
      return ctx.badRequest('Kullanici bulunamadi.');
    }

    await strapi.entityService.update(
      'plugin::users-permissions.user',
      user.id,
      { data: { password: newPassword } },
    );
    resetCodes.delete(identifier);

    ctx.body = { ok: true, identifier };
  },
};
