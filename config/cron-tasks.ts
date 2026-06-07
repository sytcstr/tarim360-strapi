export default {
  '0 * * * * *': async ({ strapi }) => {
    const now = new Date().toISOString();
    const result = await strapi.db
      .query('api::deleted-account-record.deleted-account-record')
      .deleteMany({
        where: {
          purgeAt: { $lte: now },
        },
      } as any);
    const count = Number((result as any)?.count ?? 0);
    if (count > 0) {
      strapi.log.info(`Expired deleted account records purged: ${count}`);
    }
  },
};
