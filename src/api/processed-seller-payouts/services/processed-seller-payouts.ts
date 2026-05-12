const PAYOUT_UID = 'api::seller-payout.seller-payout';

type Identity = {
  email: string;
  ownerId: string;
};

const asString = (value: unknown): string => String(value ?? '').trim();

const asNumber = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = asString(value).replace(',', '.');
  if (!raw) return 0;
  const num = Number(raw);
  return Number.isFinite(num) ? num : 0;
};

const mapPayout = (entity: any) => ({
  remoteId: String(entity?.id ?? ''),
  orderId: asString(entity?.orderId),
  sellerId: asString(entity?.sellerId),
  totalAmount: asNumber(entity?.totalAmount),
  commissionAmount: asNumber(entity?.commissionAmount),
  sellerEarning: asNumber(entity?.sellerEarning),
  status: asString(entity?.status) || 'pending',
  note: asString(entity?.note),
  paidAtIso: asString(entity?.paidAt),
  createdAtIso: asString(entity?.createdAt),
  updatedAtIso: asString(entity?.updatedAt),
});

export default ({ strapi }: { strapi: any }) => ({
  async getMine({ identity }: { identity: Identity }) {
    const rows = await strapi.db.query(PAYOUT_UID).findMany({
      where: { sellerId: identity.ownerId },
      select: [
        'id',
        'orderId',
        'sellerId',
        'totalAmount',
        'commissionAmount',
        'sellerEarning',
        'status',
        'note',
        'paidAt',
        'createdAt',
        'updatedAt',
      ],
      orderBy: { createdAt: 'desc' },
    } as any);

    const list = Array.isArray(rows) ? rows : [];
    return list.map(mapPayout);
  },
});
