/**
 * engagement-interaction router — intentionally exposes no public routes.
 * This content-type is internal bookkeeping for the like/favorite engine
 * (see src/api/engagement/controllers/engagement.ts); it is only ever
 * read/written via strapi.entityService / strapi.db.query from server-side
 * code, never via the public REST API.
 */
export default {
  routes: [],
};
