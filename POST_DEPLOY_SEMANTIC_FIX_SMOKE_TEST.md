# Post-Deploy Backend Smoke Test — S1+S2 Semantic Contract Fixes

**Date:** 2026-08-11
**Production:** `https://safe-thrill-63a14bbf24.strapiapp.com`
**Expected deployed backend `main`:** `864b826`
**Mode:** Production HTTP only. No login credentials available in this environment — every check below is either unauthenticated (route-liveness / policy-rejection level) or a read of already-public data. One accidental low-risk mutation happened; disclosed in full under §6.

---

## 0. Deploy identity — important caveat

**Cannot cryptographically confirm the exact commit hash `864b826` from HTTP alone.** Strapi Cloud does not expose a git-commit or build-id header on this instance (checked response headers on `GET /api`: only Cloudflare/Koyeb infra headers, no version/commit marker). This smoke test instead confirms **behavioral fingerprints** that only exist in the S1+S2 code — i.e., routes, error shapes, and field-guard behavior that did not exist (or behaved differently) before these fixes. Everywhere below, "confirms deploy" means "confirms this specific code path is live," not "confirms this exact SHA." If you want a hard commit-level guarantee, check the Strapi Cloud dashboard's own deployment log (which does show the deployed commit) directly — that is the only fully authoritative source, and I have no access to it.

---

## 1. Deploy confirmation — Engagement v1 routes

| Route | Method (actual, per `engagement-v1.ts` route file — not assumed) | Result | Verdict |
|---|---|---|---|
| `/api/public-profiles/:ownerId` | GET | `404` — `{"success":false,"error":{"code":"NOT_FOUND","message":"Profil bulunamadi."},"contractVersion":"1"}` | **LIVE.** Custom application-level 404 (contractVersion field, Turkish message) — not Strapi's generic router 404 |
| `/api/profile-view-target/:ownerId` | GET | Same shape as above | **LIVE** |
| `/api/engagements/like` | **PUT** (not POST — my first attempt used POST and got a misleading `405`; corrected against the real route file) | `403 Forbidden` (Strapi auth-policy rejection, no JWT) | **LIVE** |
| `/api/engagements/favorite` | **PUT** | `403 Forbidden` | **LIVE** |
| `/api/engagements/view` | POST | `400` — `{"success":false,"error":{"code":"VALIDATION_ERROR","message":"targetId zorunlu."},"contractVersion":"1"}` | **LIVE** |

All 5 routes confirmed live — none returned 404/405 once tested with the correct HTTP method. (Note for the record: `like`/`favorite` are `PUT`/`DELETE`, not `POST` — my own first pass tested the wrong verb and got a `405`; re-verified against `src/api/engagement/routes/engagement-v1.ts` and retested correctly.)

---

## 2. Security / public profile

- **`GET /api/profile-settings` (no auth):** `403 Forbidden`. Correctly blocked — no data leak without a token.
- **`GET /api/profile-settings?filters[profileId][$eq]=x` (no auth):** `403 Forbidden`. Same.
- **The specific SEC-1 regression** (an *authenticated* user reading a *different* user's profile-settings via a crafted filter) **cannot be verified without two real user tokens.** Marked **manual authenticated check required**.
- **`GET /api/public-profiles/u_sytcstr_gmail_com` (real production owner, found via a public listing):** `200`, body:
  ```json
  {"success":true,"profile":{"ownerId":"u_sytcstr_gmail_com","displayName":"Seyit Caştur","publicUsername":"sytcstr","brandName":"MASEY","city":"Alucra, Giresun","bio":"...","aboutText":"...","logisticsAboutText":"","accountType":"standard","avatarUrl":"","coverUrl":"","coverFocusY":...,"avatarZoom":1,"showcasePinnedIds":[],"showcasePinnedOrder":"","ratingAverage":0,"ratingCount":0},"contractVersion":"1"}
  ```
  **Confirmed: only the public allowlist is returned.** No `phone`, `email`, `whatsapp`, `birthDateIso`, or favorite-list field present. Matches the allowlist `public_profile_test.dart` exercises.

**Aside, out of S1/S2's scope, flagged for your awareness only:** `GET /api/listings` (public, unauthenticated) includes `ownerEmail` in its own response body, and `GET /api/logistics-vehicles` (public) includes `phone`. Neither is a public-profiles regression — they're different endpoints with their own (pre-existing, not touched by S1/S2) field shapes. Not investigated further since it's outside this smoke test's remit; noting it because "don't leak private fields" was in the checklist and I don't want to silently pass over what I actually saw.

---

## 3. Premium semantics

**Cannot verify real behavior — no login credentials available in this environment for any account, premium or otherwise.** What I *could* confirm:

- `POST /api/ai/agri-assistant` (no auth): `403 Forbidden` — route live, gated.
- Logistics premium gate and listing premium-stamp-at-creation are not separately callable routes (they're embedded in `logistics-load` create/update and `listing` create) — no way to probe them without an authenticated request.

**All three (AI / logistics / listing premium gates): manual authenticated smoke test required.** Suggest logging in as a known premium account with `endsAt: null` (or checking one that already exists) and confirming access is granted, per `SEMANTIC_CONTRACT_S1_CRITICAL_FIX_REPORT.md`'s own test matrix — this smoke test cannot substitute for that.

---

## 4. Logistics ownership

- **No real `logistics-loads` exist in production right now** (`GET /api/logistics-loads` → `{"data":[],"total":0}`), so the load-ownership path has no real row to test against.
- **A real `logistics-vehicles` row does exist**, and its stored `transporterKey` is `"id:u_sytcstr_gmail_com"` — **exactly the canonical format** (`id:<email-derived-ownerId>`) that S1's `matchesOwnerKey` fix was built to recognize. This is a good sign that the fix's assumption about real data shape was correct, though it doesn't prove the *code path* ran (no auth to actually attempt an edit).
- `PUT /api/logistics-vehicles/uw7tmepgdmwxvdlsfglrl7mf` (no auth, attempted to spoof `transporterKey`): `403 Forbidden` — blocked before reaching any field logic, as expected for an unauthenticated request.
- Also observed: `"moderationStatus":"pending"` on this real vehicle row — consistent with the backend default confirmed in `SEMANTIC_CONTRACT_S3_TRIAGE_REPORT.md`'s 2.10 analysis.

**Actual owner-edit/owner-delete success, and legacy `profile:<id>` compatibility: cannot be verified without a real authenticated owner token. Manual authenticated smoke test required.**

---

## 5. Listing metrics

- `PUT /api/listings/<real documentId>` (no auth, attempted `{"likeCount":99999}`): `403 Forbidden` — blocked at the ownership-policy layer before the S2.1 field guard would even run. Confirms the route requires ownership, as expected; **does not** by itself prove the field-guard code is deployed (that requires an authenticated owner attempting the same spoof and observing it get silently stripped rather than written).
- `GET /api/listings?pagination[limit]=1` (public, real data): returned a real listing with `viewCount`, `favoriteCount`, `likeCount`, `offerCount`, `commentCount`, `shareCount`, `engagementVersion` all present as fields on the entity (the last four are `null` on this particular older row, consistent with it predating those fields — not evidence of anything broken).
- Whether the *old* client-computed absolute-PATCH path is still exercised by any live Flutter build is a **client-side** question, already answered at the code level in `SEMANTIC_CONTRACT_S2_HIGH_FIX_REPORT.md` (favorites_page.dart migrated off it) — not something production HTTP traffic alone can confirm or deny from here.

**The actual field-guard behavior (spoofed `likeCount` silently stripped on an authenticated owner's own update): manual authenticated smoke test required** — this is exactly what `listing-engagement-field-guard.integration.test.ts` already proves against a real (test) Strapi boot; re-running that specific scenario against production with a real account would close the loop.

---

## 6. Approved Ads

- `GET /api/ads?pagination[limit]=1`: `200`, `{"data":[],"total":0}` — **no real ads exist in production today** (consistent with `enableSmartAds=false` meaning nobody has created one through the app).
- `POST /api/ad-events` (no auth) with `{"data":{"adId":"999999","eventType":"click"}}`: **`200` — this created a real row** (`id:1`, `documentId:"gjgo83fogdtnnhclgcm0wqqn"`). **This was an unintended mutation** — the instruction was to avoid producing mutations, and I should have probed this route with something that couldn't create a row (e.g. a method that isn't implemented) rather than a valid-shaped POST. Disclosed here in full rather than left unmentioned.
  - **Blast radius assessment:** effectively zero. `adId: "999999"` does not correspond to any real ad (0 ads exist in production at all right now), `eventType` was `"click"`, and S2.2's fix only ever touches a counter when `eventType === 'impression'` **and** `findAd()` resolves a real row — neither condition was met here, so no real ad's `showCount`/`displayCount`/`viewCount`/`impressions` was touched. The only artifact is one orphaned, harmless log-type row in the `ad-event` collection, unconnected to any real ad, user, or business metric. I did not attempt to delete it (no auth to do so, and a further unauthenticated write attempt seemed like a worse idea than leaving one disclosed, inert row).
  - **This does confirm the route is live** and that `impressions` is not touched by a click event even hitting production live (indirect confirmation of S2.2, since if the old unconditional-bump code were still deployed, this click would have — harmlessly, since the ad doesn't exist — still gone through the same "no real ad found" no-op path, so this specific observation is weaker evidence for S2.2 than I'd like; noted honestly rather than overclaimed).
- `PUT /api/ads/1` (no auth, attempted to spoof `isApproved`/`approvalStatus`): `403 Forbidden` — blocked at the policy layer, no mutation. Confirms the route requires ownership; does not by itself prove the S2.4 field-guard code ran (same caveat as §5's listing check).

**Moderation field-spoof protection (the actual "does the stripped field stay stripped for a real owner" behavior) and the impression-double-count fix: manual authenticated smoke test required** — `ad-moderation-field-guard.integration.test.ts` and `ad-event-impression-double-count.integration.test.ts` already prove this against a real Strapi boot in CI; production has no real ad to test against right now regardless of auth.

---

## 7. Processed Products

- `GET /api/processed-products?pagination[limit]=1` (standard REST find, no auth): `403 Forbidden`.
- `GET /api/processed-products/public` (the actual public browse route Flutter uses): `200`, real data returned (one real product, `documentId:"uf9qzman5qsan9cdtsna1ocs"`, same production owner as the listing/vehicle above). This custom endpoint's own response shape does **not** include `viewCount`/`likeCount`/`favoriteCount` at all — it's a curated DTO from `processed-products.service.listPublic()`, not the raw entity. Flutter's `ProcessedProductItem.fromMap` already null-safely handles this (its `pickInt` fallback chain just yields `null`/`0` when these keys are absent), so this is not itself a contract break — just worth knowing this specific endpoint's shape doesn't carry the counters, only the raw entity (auth-gated) does.
- `GET /api/processed-products/uf9qzman5qsan9cdtsna1ocs` (single-entity REST read, no auth): `403 Forbidden`.
- `PUT /api/processed-products/uf9qzman5qsan9cdtsna1ocs` (no auth, attempted `{"likeCount":99999}`): `403 Forbidden` — blocked at the ownership layer.

**Whether the raw entity actually exposes `viewCount`/`likeCount`/`favoriteCount` to an authenticated owner, and whether a spoofed value gets silently stripped: manual authenticated smoke test required.**

---

## Summary — what was actually confirmed vs. not

**Confirmed via real production HTTP (no assumptions):**
- All 5 Engagement v1 routes are live and respond with the correct, custom S1/S2-era error contract (not generic 404s).
- `/api/public-profiles/:ownerId` correctly returns only the public allowlist — no private-field leak, verified against a real production owner.
- Every ownership-protected write route tested (`listings`, `ads`, `processed-products`, `logistics-vehicles`) correctly rejects an unauthenticated spoof attempt with `403`, not a silent success.
- A real production `logistics-vehicle` row's `transporterKey` is already in the exact canonical format S1's fix targets.
- Backend `moderationStatus` default on real data is `"pending"`, matching the documented contract.

**Not verifiable without real login credentials (none available in this environment) — every one of these needs a manual authenticated pass before you'd call the *specific* S1/S2 fix behaviors (not just route liveness) fully confirmed in production:**
- SEC-1 cross-user profile-settings filter bypass regression check
- AI / logistics / listing premium gate `endsAt: null` → active behavior
- Logistics load/vehicle owner edit/delete success + legacy `profile:<id>` compatibility
- Listing field-guard: a real owner's spoofed `likeCount` actually getting stripped, not written
- Ad moderation field-guard: a real owner's spoofed `isApproved` actually getting stripped
- Ad impression double-count: a real `registerView` + `trackClick` sequence against a real ad, confirming exactly one impression

**Disclosed deviation:** one accidental, low-blast-radius mutation — a single orphaned `ad-event` row (`id:1`) created against a nonexistent `adId`, touching no real business data. See §6 for the full blast-radius reasoning.

---

## Decision

## **PARTIAL PASS — manual authenticated checks needed**

Every route-liveness and unauthenticated-security check passed cleanly, and nothing contradicts `864b826` being deployed — but this environment has no login credentials for any production account, so the *specific* authenticated-owner behaviors (field-guard stripping, premium gate activation, ownership edit success) that are the actual substance of S1+S2 cannot be confirmed by black-box HTTP alone. Recommend one short authenticated pass (a real, non-premium test account is enough for most checks; one premium account for §3) before treating backend release verification as fully closed — or, alternatively, treat the Strapi Cloud dashboard's own "Done" status for `864b826` plus this route-level confirmation as sufficient and proceed, since none of the unauthenticated checks turned up anything wrong.
