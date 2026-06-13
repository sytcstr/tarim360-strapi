import type { Core } from '@strapi/strapi';

const TARGETS = [
  {
    uid: 'api::offer.offer',
    prefix: 'legacy_offer',
  },
  {
    uid: 'api::logistics-offer.logistics-offer',
    prefix: 'legacy_logistics_offer',
  },
] as const;

const clean = (value: unknown): string => String(value ?? '').trim();

export const runOfferIdDedupeOnce = async (strapi: Core.Strapi) => {
  const appStore = strapi.store({ type: 'core', name: 'bootstrap' });
  const key = 'offer_id_dedupe_v1_done';
  if ((await appStore.get({ key })) === true) {
    strapi.log.info('Offer ID dedupe skipped (already done).');
    return;
  }

  let deleted = 0;
  let backfilled = 0;

  for (const target of TARGETS) {
    const rows = await strapi.db.query(target.uid).findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    } as any);
    const seen = new Set<string>();

    for (const row of Array.isArray(rows) ? rows : []) {
      const id = Number((row as any)?.id ?? 0);
      if (!Number.isInteger(id) || id <= 0) continue;

      const fallbackId =
        clean((row as any)?.documentId) || clean((row as any)?.id);
      const offerId =
        clean((row as any)?.offerId) || `${target.prefix}_${fallbackId}`;

      if (seen.has(offerId)) {
        await strapi.db.query(target.uid).delete({ where: { id } } as any);
        deleted += 1;
        continue;
      }

      seen.add(offerId);
      if (clean((row as any)?.offerId) !== offerId) {
        await strapi.db.query(target.uid).update({
          where: { id },
          data: { offerId },
        } as any);
        backfilled += 1;
      }
    }
  }

  await appStore.set({ key, value: true });
  strapi.log.info(
    `Offer ID dedupe completed: deleted=${deleted}, backfilled=${backfilled}.`,
  );
};
