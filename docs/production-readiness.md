# Production readiness: agricultural data and reference content

## What is production-safe now

- **Reference seed** (`src/utils/reference-seed.ts`): 81 provinces and 52
  agricultural products (names/categories/units only, no prices).
  `REFERENCE_SEED_MODE=off|dry-run|apply`, default `off`.
  - `dry-run` is read-only and prints aggregate counts (existing, unpublished,
    would-create, conflicts).
  - `apply` is create-only (create + publish). It never updates or deletes.
    An inconsistent collision (same slug with another plate/code, or slug and
    plate on different documents) makes the whole run fail closed with zero
    writes.
  - The version marker `agri-reference@1` is written to the core store only
    after a fully successful apply. It never hides a missing record: every run
    re-checks the catalogue against the database.
  - Recommended rollout on Strapi Cloud: deploy with the flag unset, set
    `REFERENCE_SEED_MODE=dry-run`, read the boot log, set `apply`, verify
    81 / 52 published rows, then set the flag back to `off`.
  - `scripts/seed-agri-reference-data.js` is a LOCAL SQLite tool that updates
    existing rows; do not use it against shared data.
- **Mock price ingestion is hard-disabled** unless `NODE_ENV` is explicitly
  `development` or `test` (and not on Strapi Cloud). `AGRI_INGESTION_ENABLED`
  alone cannot enable it in production.
- **Market snapshot** (`/api/market/snapshot`): every value is provider data,
  unit-validated; failed providers leave that field `null` (the app shows
  "—"). Adds `eurTry`.

## BLOCKER / DECISION REQUIRED

1. **Real agricultural price provider.** No provider has been chosen
   (TMO / TUIK / commodity exchange / wholesale market). Until one is
   connected, `agri-price-observation` stays empty and the app shows an honest
   "no price data" state. Do not seed observations.
2. **Open-Meteo commercial licence.** The free Open-Meteo API is for
   non-commercial use and requires CC BY 4.0 attribution. The mobile app calls
   `api.open-meteo.com` directly (Home weather card and the Agricultural Data
   fallback). Before a commercial release decide: commercial plan
   (`customer-api.open-meteo.com` + API key) or another provider, and add the
   visible attribution.
3. **Hub editorial content.** `hub-category`, `hub-banner` and editorial
   `hub-content` are intentionally not seeded; they need real editorial input.
   The app works without them (empty states).
