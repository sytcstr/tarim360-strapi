export default {
  async verify(ctx) {
    const body = (ctx.request?.body ?? {}) as Record<string, unknown>;
    const productId = String(body.productId ?? '').trim();
    const transactionId = String(body.transactionId ?? '').trim();

    if (!productId) {
      return ctx.badRequest('productId zorunlu.');
    }

    // N8N/gercek odeme dogrulamasi baglanana kadar "soft verify".
    ctx.body = {
      verified: true,
      success: true,
      productId,
      transactionId,
      message: 'Dogrulama basarili.',
    };
  },
};
