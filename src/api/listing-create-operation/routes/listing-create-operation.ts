/**
 * listing-create-operation router — intentionally exposes no public
 * routes. PRE_UAT_F1_TARGETED_FUNCTIONAL_FIX_REPORT.md F1.6: this
 * content-type is a server-side idempotency ledger for listing.create
 * (the atomic-claim pattern already used by rocket-activation for
 * listing.activateRocket) -- it exists only to survive the listing
 * content-type's draftAndPublish:true dual-row create behavior, which
 * makes storing operationId directly on the listing row itself unsafe.
 * Only ever read/written via strapi.entityService / strapi.db.query from
 * server-side code, never via the public REST API.
 */
export default {
  routes: [],
};
