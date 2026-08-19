/**
 * rocket-activation router — intentionally exposes no public routes.
 * This content-type is a server-side idempotency + consumption ledger
 * for listing.activateRocket (see PREMIUM_P1_TARGETED_FIX_REPORT.md,
 * BUG-PREM-001); it is only ever read/written via strapi.entityService /
 * strapi.db.query from server-side code, never via the public REST API.
 */
export default {
  routes: [],
};
