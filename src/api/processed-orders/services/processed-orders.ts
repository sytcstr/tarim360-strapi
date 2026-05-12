import { loadEntityByRouteId } from '../../../utils/identity';

const ORDER_UID = 'api::order.order';
const ORDER_ITEM_UID = 'api::order-item.order-item';
const COMMISSION_UID = 'api::commission-record.commission-record';
const PAYOUT_UID = 'api::seller-payout.seller-payout';
const ALLOWED_STATUSES = new Set(['pending', 'shipping', 'delivered']);

type Identity = {
  email: string;
  ownerId: string;
};

type NormalizedOrderItem = {
  productLocalId: string;
  sellerId: string;
  quantity: number;
  price: number;
  total: number;
};

type CreateInput = {
  userId: string;
  items: unknown;
  totalAmount: number;
  address: string;
  localOrderId: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const asString = (value: unknown): string => String(value ?? '').trim();

const asNumber = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = asString(value).replace(',', '.');
  if (!raw) return 0;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
};

const asInteger = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  const num = Number.parseInt(asString(value), 10);
  return Number.isInteger(num) ? num : fallback;
};

const roundCurrency = (value: number): number =>
  Math.round((value + Number.EPSILON) * 100) / 100;

const httpError = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });

const normalizeStatus = (value: unknown): string => {
  const status = asString(value).toLowerCase();
  return ALLOWED_STATUSES.has(status) ? status : '';
};

const stringifyAddress = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (!isRecord(value)) return '';

  const lines = [
    asString(value.fullName ?? value.name),
    asString(value.phone),
    asString(value.city),
    asString(value.addressLine ?? value.address),
  ].filter((line) => line.length > 0);

  if (lines.length > 0) return lines.join('\n');

  try {
    return JSON.stringify(value);
  } catch (_) {
    return '';
  }
};

const normalizeOrderItems = (value: unknown): NormalizedOrderItem[] => {
  if (!Array.isArray(value)) {
    throw httpError(400, 'items alani dizi olmalidir.');
  }

  return value.map((raw, index) => {
    if (!isRecord(raw)) {
      throw httpError(400, `${index + 1}. siparis kalemi gecersiz.`);
    }

    const productLocalId = asString(raw.productLocalId ?? raw.productId);
    const sellerId = asString(raw.sellerId);
    const quantity = Math.max(1, asInteger(raw.quantity, 1));
    const price = roundCurrency(Math.max(0, asNumber(raw.price)));
    const rawTotal = roundCurrency(Math.max(0, asNumber(raw.total)));
    const total = rawTotal > 0 ? rawTotal : roundCurrency(price * quantity);

    if (!productLocalId) {
      throw httpError(400, `${index + 1}. siparis kaleminde productLocalId zorunlu.`);
    }
    if (!sellerId) {
      throw httpError(400, `${index + 1}. siparis kaleminde sellerId zorunlu.`);
    }

    return {
      productLocalId,
      sellerId,
      quantity,
      price,
      total,
    };
  });
};

const getCreateInput = (body: unknown): CreateInput => {
  const root = isRecord(body) ? body : {};
  const nestedOrder = isRecord(root.order) ? root.order : root;

  return {
    userId: asString(root.userId ?? nestedOrder.userId ?? nestedOrder.user),
    items: root.items ?? nestedOrder.items ?? [],
    totalAmount: asNumber(root.totalAmount ?? nestedOrder.totalAmount),
    address: stringifyAddress(root.address ?? nestedOrder.address),
    localOrderId: asString(root.localOrderId ?? nestedOrder.localOrderId),
  };
};

const sumItemTotals = (items: NormalizedOrderItem[]): number =>
  roundCurrency(items.reduce((sum, item) => sum + item.total, 0));

const groupTotalsBySeller = (items: NormalizedOrderItem[]): Map<string, number> => {
  const totals = new Map<string, number>();
  for (const item of items) {
    totals.set(item.sellerId, roundCurrency((totals.get(item.sellerId) ?? 0) + item.total));
  }
  return totals;
};

const queryOrderItemsByOrder = async (strapi: any, orderId: number) => {
  const direct = await strapi.db.query(ORDER_ITEM_UID).findMany({
    where: { order: orderId },
    select: ['id', 'sellerId', 'productLocalId', 'quantity', 'price', 'total'],
  } as any);
  const rows = Array.isArray(direct) ? direct : [];
  if (rows.length > 0) return rows;

  const nested = await strapi.db.query(ORDER_ITEM_UID).findMany({
    where: { order: { id: orderId } },
    select: ['id', 'sellerId', 'productLocalId', 'quantity', 'price', 'total'],
  } as any);
  return Array.isArray(nested) ? nested : [];
};

const querySellerPayouts = async (strapi: any, orderId: string, sellerId: string) => {
  const rows = await strapi.db.query(PAYOUT_UID).findMany({
    where: { orderId, sellerId },
    select: ['id', 'status'],
  } as any);
  return Array.isArray(rows) ? rows : [];
};

export default ({ strapi }: { strapi: any }) => ({
  async createOrderBundle({
    body,
    authUserId,
  }: {
    body: unknown;
    authUserId: number;
  }) {
    const input = getCreateInput(body);
    if (input.userId && Number(input.userId) !== authUserId) {
      throw httpError(403, 'userId oturum kullanicisi ile eslesmiyor.');
    }
    if (!input.address) {
      throw httpError(400, 'address zorunlu.');
    }

    const items = normalizeOrderItems(input.items);
    if (items.length === 0) {
      throw httpError(400, 'En az bir siparis kalemi zorunlu.');
    }

    const computedTotal = sumItemTotals(items);
    if (input.totalAmount > 0 && Math.abs(input.totalAmount - computedTotal) > 0.01) {
      strapi.log.warn(
        `Processed order total mismatch ignored. client=${input.totalAmount} server=${computedTotal}`,
      );
    }

    const createdOrder = await strapi.entityService.create(ORDER_UID as any, {
      data: {
        user: authUserId,
        totalAmount: computedTotal,
        status: 'pending',
        address: input.address,
        localOrderId: input.localOrderId || null,
      },
    });

    const orderId = Number((createdOrder as any)?.id ?? 0);
    if (!orderId) {
      throw httpError(500, 'Order kaydi olusturuldu ancak id okunamadi.');
    }

    const createdItems = [] as any[];
    for (const item of items) {
      const created = await strapi.entityService.create(ORDER_ITEM_UID as any, {
        data: {
          order: orderId,
          productLocalId: item.productLocalId,
          sellerId: item.sellerId,
          quantity: item.quantity,
          price: item.price,
          total: item.total,
        },
      });
      createdItems.push(created);
    }

    const createdCommissionRecords = [] as any[];
    const createdPayoutRecords = [] as any[];
    for (const [sellerId, totalAmount] of groupTotalsBySeller(items).entries()) {
      const commissionAmount = roundCurrency(totalAmount * 0.01);
      const sellerEarning = roundCurrency(totalAmount - commissionAmount);
      const createdCommission = await strapi.entityService.create(COMMISSION_UID as any, {
        data: {
          orderId: String(orderId),
          sellerId,
          totalAmount,
          commissionAmount,
          sellerEarning,
        },
      });
      createdCommissionRecords.push(createdCommission);

      const createdPayout = await strapi.entityService.create(PAYOUT_UID as any, {
        data: {
          orderId: String(orderId),
          sellerId,
          totalAmount,
          commissionAmount,
          sellerEarning,
          status: 'pending',
          note: null,
          paidAt: null,
        },
      });
      createdPayoutRecords.push(createdPayout);
    }

    return {
      order: createdOrder,
      items: createdItems,
      commissionRecords: createdCommissionRecords,
      payoutRecords: createdPayoutRecords,
    };
  },

  async updateOrderStatus({
    body,
    identity,
  }: {
    body: unknown;
    identity: Identity;
  }) {
    const root = isRecord(body) ? body : {};
    const orderId = asString(root.orderId);
    const requestedSellerId = asString(root.sellerId);
    const nextStatus = normalizeStatus(root.status);

    if (!orderId) {
      throw httpError(400, 'orderId zorunlu.');
    }
    if (!nextStatus) {
      throw httpError(400, 'status gecersiz.');
    }
    if (requestedSellerId && requestedSellerId !== identity.ownerId) {
      throw httpError(403, 'sellerId oturumdaki satici ile eslesmiyor.');
    }

    const order = await loadEntityByRouteId(strapi, ORDER_UID, orderId, [
      'id',
      'documentId',
      'status',
      'totalAmount',
      'address',
      'localOrderId',
    ]);
    if (!order) {
      throw httpError(404, 'Siparis bulunamadi.');
    }

    const numericOrderId = Number((order as any)?.id ?? 0);
    if (!numericOrderId) {
      throw httpError(500, 'Siparis id bilgisi okunamadi.');
    }

    const orderItems = await queryOrderItemsByOrder(strapi, numericOrderId);
    if (orderItems.length === 0) {
      throw httpError(404, 'Siparis kalemleri bulunamadi.');
    }

    const hasSellerAccess = orderItems.some(
      (item) => asString((item as any)?.sellerId) === identity.ownerId,
    );
    if (!hasSellerAccess) {
      throw httpError(403, 'Bu siparisi guncelleme yetkiniz yok.');
    }

    const updatedOrder = await strapi.entityService.update(ORDER_UID as any, numericOrderId, {
      data: {
        status: nextStatus,
      },
    });

    const payoutRows = await querySellerPayouts(strapi, String(numericOrderId), identity.ownerId);
    const nextPayoutStatus = nextStatus === 'delivered' ? 'ready' : 'pending';
    for (const row of payoutRows) {
      const payoutId = Number((row as any)?.id ?? 0);
      const currentStatus = asString((row as any)?.status);
      if (!payoutId || currentStatus === 'paid' || currentStatus === 'blocked') continue;
      await strapi.entityService.update(PAYOUT_UID as any, payoutId, {
        data: {
          status: nextPayoutStatus,
        },
      });
    }

    return {
      order: updatedOrder,
      items: orderItems,
    };
  },
});
