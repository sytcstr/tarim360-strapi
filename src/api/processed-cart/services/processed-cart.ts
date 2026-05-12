const CART_UID = 'api::cart.cart';
const CART_ITEM_UID = 'api::cart-item.cart-item';

type Identity = {
  email: string;
  ownerId: string;
};

type NormalizedCartItem = {
  productLocalId: string;
  sellerId: string;
  quantity: number;
  price: number;
  total: number;
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

const normalizeCartItems = (value: unknown): NormalizedCartItem[] => {
  if (!Array.isArray(value)) {
    throw httpError(400, 'items alani dizi olmalidir.');
  }

  return value.map((raw, index) => {
    if (!isRecord(raw)) {
      throw httpError(400, `${index + 1}. sepet kalemi gecersiz.`);
    }
    const productLocalId = asString(raw.productLocalId ?? raw.productId);
    const sellerId = asString(raw.sellerId);
    const quantity = Math.max(1, asInteger(raw.quantity, 1));
    const price = roundCurrency(Math.max(0, asNumber(raw.price)));
    const rawTotal = roundCurrency(Math.max(0, asNumber(raw.total)));
    const total = rawTotal > 0 ? rawTotal : roundCurrency(price * quantity);

    if (!productLocalId) {
      throw httpError(400, `${index + 1}. sepet kaleminde productLocalId zorunlu.`);
    }
    if (!sellerId) {
      throw httpError(400, `${index + 1}. sepet kaleminde sellerId zorunlu.`);
    }

    return { productLocalId, sellerId, quantity, price, total };
  });
};

const mapCartItem = (entity: any) => ({
  id: String(entity?.id ?? ''),
  productLocalId: asString(entity?.productLocalId),
  sellerId: asString(entity?.sellerId),
  quantity: asInteger(entity?.quantity, 1),
  price: asNumber(entity?.price),
  total: asNumber(entity?.total),
  addedAtIso: asString(entity?.createdAt),
});

const mapCart = (entity: any, items: any[]) => {
  if (!entity || typeof entity !== 'object') return null;
  return {
    remoteId: String(entity.id ?? ''),
    localCartId: asString(entity.localCartId),
    status: asString(entity.status),
    totalAmount: asNumber(entity.totalAmount),
    items: items.map(mapCartItem),
    createdAtIso: asString(entity.createdAt),
    updatedAtIso: asString(entity.updatedAt),
  };
};

const findActiveCart = async (strapi: any, authUserId: number, localCartId?: string) => {
  if (localCartId && localCartId.trim().length > 0) {
    const byLocalId = await strapi.db.query(CART_UID).findOne({
      where: {
        user: authUserId,
        localCartId: localCartId.trim(),
      },
      select: ['id', 'documentId', 'localCartId', 'status', 'totalAmount', 'createdAt', 'updatedAt'],
    } as any);
    if (byLocalId) return byLocalId;
  }

  return strapi.db.query(CART_UID).findOne({
    where: {
      user: authUserId,
      status: 'active',
    },
    select: ['id', 'documentId', 'localCartId', 'status', 'totalAmount', 'createdAt', 'updatedAt'],
    orderBy: { updatedAt: 'desc' },
  } as any);
};

const findCartItems = async (strapi: any, cartId: number) => {
  const rows = await strapi.db.query(CART_ITEM_UID).findMany({
    where: { cart: cartId },
    select: ['id', 'productLocalId', 'sellerId', 'quantity', 'price', 'total', 'createdAt'],
    orderBy: { createdAt: 'asc' },
  } as any);
  return Array.isArray(rows) ? rows : [];
};

export default ({ strapi }: { strapi: any }) => ({
  async getMine({ authUserId }: { authUserId: number; identity: Identity }) {
    const cart = await findActiveCart(strapi, authUserId);
    if (!cart) return null;
    const cartId = Number((cart as any)?.id ?? 0);
    const items = cartId > 0 ? await findCartItems(strapi, cartId) : [];
    return mapCart(cart, items);
  },

  async syncCart({ authUserId, body }: { authUserId: number; identity: Identity; body: unknown }) {
    const root = isRecord(body) ? body : {};
    const localCartId = asString(root.localCartId);
    const items = normalizeCartItems(root.items ?? []);
    const totalAmount = roundCurrency(items.reduce((sum, item) => sum + item.total, 0));

    const existing = await findActiveCart(strapi, authUserId, localCartId);
    const cartData = {
      user: authUserId,
      localCartId: localCartId || null,
      status: items.length === 0 ? 'cleared' : 'active',
      totalAmount,
    };

    const cart = existing
      ? await strapi.entityService.update(CART_UID as any, Number((existing as any).id), { data: cartData })
      : await strapi.entityService.create(CART_UID as any, { data: cartData });

    const cartId = Number((cart as any)?.id ?? 0);
    if (!cartId) {
      throw httpError(500, 'Sepet kaydi olusturuldu ancak id okunamadi.');
    }

    const existingItems = await findCartItems(strapi, cartId);
    for (const row of existingItems) {
      const itemId = Number((row as any)?.id ?? 0);
      if (itemId > 0) {
        await strapi.entityService.delete(CART_ITEM_UID as any, itemId);
      }
    }

    const createdItems = [] as any[];
    for (const item of items) {
      const created = await strapi.entityService.create(CART_ITEM_UID as any, {
        data: {
          cart: cartId,
          productLocalId: item.productLocalId,
          sellerId: item.sellerId,
          quantity: item.quantity,
          price: item.price,
          total: item.total,
        },
      });
      createdItems.push(created);
    }

    return mapCart(cart, createdItems);
  },

  async clearCart({ authUserId, body }: { authUserId: number; identity: Identity; body: unknown }) {
    const root = isRecord(body) ? body : {};
    const localCartId = asString(root.localCartId);
    const cart = await findActiveCart(strapi, authUserId, localCartId);
    if (!cart) return { cleared: true };

    const cartId = Number((cart as any)?.id ?? 0);
    const existingItems = cartId > 0 ? await findCartItems(strapi, cartId) : [];
    for (const row of existingItems) {
      const itemId = Number((row as any)?.id ?? 0);
      if (itemId > 0) {
        await strapi.entityService.delete(CART_ITEM_UID as any, itemId);
      }
    }

    await strapi.entityService.update(CART_UID as any, cartId, {
      data: {
        status: 'cleared',
        totalAmount: 0,
      },
    });

    return { cleared: true };
  },
});
