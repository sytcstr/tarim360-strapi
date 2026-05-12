import { normalizePromoCode } from '../../../../utils/promo';

const syncCodeFields = (data: Record<string, unknown>) => {
  const code = String(data.code ?? '').trim();
  if (!code) {
    throw new Error('Promosyon kodu zorunludur.');
  }
  const normalized = normalizePromoCode(code);
  if (!normalized) {
    throw new Error('Promosyon kodu gecersiz.');
  }
  data.code = code.toUpperCase();
  data.codeNormalized = normalized;
};

export default {
  async beforeCreate(event: any) {
    const data = ((event.params ?? {}).data ?? {}) as Record<string, unknown>;
    syncCodeFields(data);
  },

  async beforeUpdate(event: any) {
    const data = ((event.params ?? {}).data ?? {}) as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(data, 'code')) return;
    syncCodeFields(data);
  },
};
