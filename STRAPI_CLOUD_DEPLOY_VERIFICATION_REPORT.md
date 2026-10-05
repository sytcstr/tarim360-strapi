# Strapi Cloud Deploy Verification Report

**Date:** 2026-08-08
**Backend branch pushed:** `feature/agri-data-strapi-schema`
**HEAD at push time:** `3237aa5`
**Scope:** Read-only production verification only. No mutation, no deploy trigger, no code change, no push performed in this phase.

## 0. Dashboard access — hard limitation, disclosed up front

**I do not have access to cloud.strapi.io.** This environment has no browser tool and no Strapi Cloud credentials/API token. I could not and did not check:

- Which GitHub repository/branch is connected in Strapi Cloud project settings.
- Whether "Deploy on every commit" / "Deploy on push" is enabled.
- The Deployments list, or whether a deployment for commit `3237aa5` exists.
- Build logs (repository checkout, dependency install, `strapi build`, database migration, bootstrap unique-index checks, application start).
- Any of the specific error signatures requested (missing `engagement_interactions`/`engagement_views` tables, unique index failures, migration failures, permission/action lookup errors, TypeScript/build failures, missing env vars, public-profile/profile-view-target route registration errors).

Everything below is derived exclusively from unauthenticated, read-only HTTP requests against the production URL. **I am not claiming a deployment happened or is in progress — that requires dashboard access I don't have.**

## 1. Production URL

Found in the Flutter app's config (`lib/services/strapi_service.dart`, `_envDefaultCloudBaseUrl`), used as the app's default backend when no `--dart-define STRAPI_BASE_URL` override is supplied:

```
https://safe-thrill-63a14bbf24.strapiapp.com
```

Confirmed live: `GET /` → `302` redirect to `/admin` (Strapi's normal unauthenticated-root behavior). Response headers show real Strapi Cloud infrastructure (`x-powered-by: Strapi <strapi.io>`, Koyeb backend headers, Cloudflare edge) — this is a genuine, reachable, healthy Strapi Cloud instance, not a placeholder or dead URL.

## 2. Health-check results

| # | Check | Method/Path | Expected | Actual | Verdict |
|---|---|---|---|---|---|
| 1 | General API reachability | `GET /` | Up | `302 → /admin` | ✅ server up |
| 1b | General API reachability | `GET /api` | Up | `404` (Strapi's generic "no route" body) | ✅ Strapi router responding |
| 2 | Public profile read | `GET /api/public-profiles/:syntheticId` | Contract 404 (`NOT_FOUND`, `contractVersion:"1"`) | Generic Strapi `{"error":{"status":404,"name":"NotFoundError","message":"Not Found"}}` — **not our controller's response shape** | ❌ route not reached |
| 3 | Profile view target lookup | `GET /api/profile-view-target/:syntheticId` | Contract 404 (`NOT_FOUND`, `contractVersion:"1"`) | Same generic Strapi 404 as above | ❌ route not reached |
| 4a | Like auth gate | `PUT /api/engagements/like` (no auth) | `401`/`403` | **`405 Method Not Allowed`**, body `"Method Not Allowed"`, header `Allow: HEAD, GET` | ❌ route does not exist for this method |
| 4b | Favorite auth gate | `PUT /api/engagements/favorite` (no auth) | `401`/`403` | Same `405`, `Allow: HEAD, GET` | ❌ route does not exist for this method |
| 5 | View payload validation | `POST /api/engagements/view` with `{}` | `400` `VALIDATION_ERROR`, `contractVersion:"1"` | Same `405`, `Allow: HEAD, GET` | ❌ route does not exist for this method |
| 6 | `contractVersion` presence | — | `"1"` present on contract responses | Not present anywhere — no request reached a controller that emits it | ❌ cannot confirm, see below |

No real ID was available for a genuine "found" test on checks 2/3 (mutation-free constraint — I cannot create a real profile to test the success path). Synthetic/nonexistent IDs were used deliberately, expecting our own `NOT_FOUND` contract shape either way; getting Strapi's generic router-level 404 instead is itself the finding.

### Cross-checks to bracket what's actually deployed

| Check | Result | Meaning |
|---|---|---|
| `GET /api/hub-contents` | `200`, real data returned | Core content-type routes work; app has real production data |
| `GET /api/listings` | `200`, real data returned | Same — core marketplace API is live and serving traffic |
| `POST /api/listing-favorites/toggle` (legacy, pre-engagement-v1, no auth) | `403 Forbidden` (Strapi's own auth-rejection shape) | **This route exists** — it's registered and its auth policy fired (unlike the 405s above, which mean "route not found for this method") |
| `GET /api/logistics-vehicles?pagination[limit]=1` | `200`, one real record returned | Record has **no** `viewCount`, `likeCount`, `favoriteCount`, or `engagementVersion` field at all |

### What this means

The evidence converges on one conclusion: **the code currently running in production predates the entire Engagement V1 effort** — not just this session's 32-commit push, but the schema/contract work from earlier in the project too:

- The brand-new `engagements/like`, `engagements/favorite`, `engagements/view`, `public-profiles`, `profile-view-target` routes don't exist in production at all (405/generic-404, not our contract responses).
- The **old**, pre-Engagement-V1 legacy route (`/listing-favorites/toggle`) *does* exist and is reachable (403, meaning it's registered and its policy ran) — this brackets production's deployed code to before commit `7764a67` ("feat: add engagement contract primitives", 2026-07-30T23:46), the first commit of this project's engagement-v1 rewrite.
- `logistics-vehicle` records in production carry **none** of the engagement fields (not even `viewCount`, which is from an earlier phase than this session's work) — confirming the production database schema itself hasn't been migrated for any part of this project's engagement work.

This is a **read-only, evidence-based inference**, not a dashboard-confirmed fact — I cannot see deploy history, so I cannot say *why* (auto-deploy disabled, never triggered, stuck on an old build, wrong branch connected, etc.). Only that production's current live behavior is consistent with "significantly behind," not with "up to date as of `3237aa5`."

## 3. No mutation performed

Confirmed: every request was either `GET`/`OPTIONS`, or a `PUT`/`POST` that was rejected before reaching any handler (405 at the router level, or 403 at the auth-policy level for the one legacy-route probe). No counter was incremented, no record was created, updated, or deleted.

## 4. Log-access-gerektiren kontroller (yapılamadı)

- Repository checkout / dependency install / `strapi build` logs
- Database migration execution logs
- Bootstrap unique-index creation logs
- Application start logs
- Any of the specific error signatures the user asked to grep for (missing tables, unique index failures, permission/action lookup errors, env var gaps, route registration errors)
- Confirmation of which Git branch/commit Strapi Cloud is actually configured to deploy from
- Whether "Deploy on push" is enabled

All of the above require dashboard or CLI access I don't have in this environment.

## 5. Gerçek cihaz smoke testi için READY / BLOCKED

# **BLOCKED**

Production is reachable and serving real traffic on its existing (pre-Engagement-V1) surface, but none of the Engagement V1 backend contract is live there yet — not the routes, not the schema fields. Every one of the 11 scenarios planned for Phase 4 (Listing Favorite, Listing View, Logistics Load Favorite, Logistics Vehicle Favorite, Processed Product Like/Favorite, Hub Like, Farmer Question Like, Profile View, Approved Ads Like/Impression) depends on backend surface that this verification shows is absent from production right now. Running the Phase 4 device smoke test against this URL today would fail across the board for reasons that have nothing to do with app correctness.

**Next step (requires you, not something I can do):** open the Strapi Cloud dashboard, confirm which branch is connected and whether auto-deploy is on, check the Deployments list for anything newer than what's live, and if nothing recent is there, trigger a manual deploy of `feature/agri-data-strapi-schema` at `3237aa5`. Once that's done, this same health-check pass can be re-run in minutes to confirm the routes/schema are live before touching Phase 4.
