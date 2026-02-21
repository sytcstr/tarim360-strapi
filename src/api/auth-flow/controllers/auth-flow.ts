const normalizeEmail = (v: unknown) => String(v ?? '').trim().toLowerCase();

const normalizeCode = (v: unknown) => String(v ?? '').trim();

export default {
  async requestSignupVerification(ctx) {
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const email = normalizeEmail(body.email);
    const phone = String(body.phone ?? '').trim();
    if (!email) {
      return ctx.badRequest('email zorunlu.');
    }

    // Dev asamasinda e-posta/SMS servisleri bagli degil.
    // UI tarafi bu endpointten sadece "basarili" donus bekliyor.
    ctx.body = {
      ok: true,
      email,
      phone,
      message: 'Dogrulama talebi alindi.',
    };
  },

  async verifySignup(ctx) {
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const email = normalizeEmail(body.email);
    const emailCode = normalizeCode(body.emailCode);
    const smsCode = normalizeCode(body.smsCode);
    if (!email) {
      return ctx.badRequest('email zorunlu.');
    }

    // Dev asamasinda kod dogrulamasi "soft pass" calisiyor:
    // en az bir kod girildi ise basarili kabul edilir.
    if (emailCode.length === 0 && smsCode.length === 0) {
      return ctx.badRequest('En az bir dogrulama kodu girin.');
    }

    ctx.body = { ok: true, email, verified: true };
  },

  async requestPasswordReset(ctx) {
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const identifier = normalizeEmail(body.identifier);
    if (!identifier) {
      return ctx.badRequest('identifier zorunlu.');
    }

    ctx.body = { ok: true, identifier };
  },

  async resetPassword(ctx) {
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const identifier = normalizeEmail(body.identifier);
    const code = normalizeCode(body.code);
    const newPassword = String(body.newPassword ?? '');

    if (!identifier) {
      return ctx.badRequest('identifier zorunlu.');
    }
    if (!code) {
      return ctx.badRequest('code zorunlu.');
    }
    if (newPassword.length < 6) {
      return ctx.badRequest('newPassword en az 6 karakter olmali.');
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

    ctx.body = { ok: true, identifier };
  },
};
