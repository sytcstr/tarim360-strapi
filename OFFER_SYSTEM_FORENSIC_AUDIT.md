# TARIM360+1 — SPRINT 4 — OFFER SYSTEM (TEKLİF SİSTEMİ) — FORENSIC AUDIT

**Read-only. No code changed, nothing committed, nothing pushed.** A local backend instance (`fix/release-messaging-reliability` branch — the current HEAD in both repos; offer system code is unrelated to and unaffected by that branch's messaging changes) was booted twice purely to live-verify findings below, then stopped both times.

Backend repo: `C:\projeler\tarim360-strapi`
Flutter repo: `C:\projeler\tarim360`

---

## 0. Scope note — an important pre-existing fact

`src/api/offer/controllers/offer.ts` has carried an **uncommitted** change since before this entire messaging sprint began (explicitly protected/untouched throughout M1–M4 per your own instruction each time). It is **directly relevant to this audit's "Sayaçlar" (counters) item**, so it's surfaced here rather than silently ignored:

```diff
+ import { recountListingOffers } from '../../../utils/listing-metrics';
  ...
  // after offer create:
+ await recountListingOffers(strapi, data.listingId ?? data.listingNo);
  // after offer delete:
+ await recountListingOffers(strapi, listingId);
```

`recountListingOffers` recomputes `listing.offerCount` from the real row count (same pattern as this codebase's other `recount*` counter fixes). `offerCount` **is** a real, displayed field (`lib/features/engagement/models/engagement_models.dart`, consumed by listing cards). Without this, `listing.offerCount` is never updated by offer create/delete at all — a real, live counter-accuracy bug that this uncommitted change already fixes correctly. **Not committed by me** (per every prior instruction in this sprint) — flagging for your explicit decision on whether to fold it into Sprint 4's fix phase.

---

## 1. What's already solid (verified, not assumed)

- **Idempotent create**: `offerId` is a client-generated, unique, required field. Create requests lock per-`offerId` (in-memory `Map`), re-check for an existing row before AND after the lock, and a concurrent-create DB race is caught and resolved to the existing row — same discipline as messaging's M5 thread-race fix. A retried create with the same `offerId` returns the original row (`idempotent: true` flag), not a duplicate.
- **Requester identity cannot be spoofed**: both the `offer-ownership` policy (runs first, on the stock `POST /offers` route) and the controller's own `create` action independently derive `requesterEmail`/`requesterProfileId` from `readIdentity(ctx)` (the real JWT session) — client-supplied requester fields are only used to *reject* a mismatch, never trusted. Self-offers (`receiver == requester`) are blocked in both layers.
- **Read/update/delete are participant-scoped**: `matchesIdentity` against `requesterEmail/receiverEmail/requesterProfileId/receiverProfileId` gates `find`, `findOne`, `updateByOfferId`, `deleteByOfferId`, and `markSeen`. A non-participant gets `403`/`404`, not the offer's data.
- **Accept/reject is receiver-only**: `updateByOfferId` explicitly requires `role.receiver` for `status ∈ {accepted, rejected}` — the requester cannot unilaterally accept their own offer. Verified by reading the exact check, not assumed.
- **Counter-offer ("Karşı teklif") correctly reuses the same offer row** — `bargain`/`_remoteBargain` (Flutter) call `updateByOfferId` on the existing `offerId`, they do not create a new offer. No duplicate-row risk from the intended renegotiation flow.
- **Offer transaction is decoupled from the chat side-channel** (cross-checked against M4's findings): `_syncOutgoingOfferToStrapi` calls `strapi.createOffer(...)` first and only *after* that succeeds does it fire-and-forget the chat-event message. A chat message failure never rolls back or blocks the real offer record — confirmed unchanged from M4's own finding, the offer stays the source of truth.

---

## 2. BUG-OFFER-001 — receiver identity is not verified against the real listing owner (HIGH)

**Confirmed live**, not theoretical. When a client supplies **both** `receiverEmail` and `receiverProfileId` in the create payload, `offer-ownership.ts`'s owner-resolution branch (`resolveListingOwnerByAnyId`) is **skipped entirely** — both fields pass through unverified. The controller's own `create` action has the identical gap (same "only resolve if empty" logic).

**Live reproduction:**
```
POST /api/offers  (as attacker@test.local)
{
  "data": {
    "offerId": "offer_<uuid>",
    "listingId": "real-listing-owned-by-someone-else-999",   // doesn't even need to be real
    "title": "Fake teklif",
    "receiverEmail": "victim@test.local",                     // arbitrary target, NOT the listing's owner
    "receiverProfileId": "u_victim_test_local"
  }
}
→ 201 Created
```
Confirmed via direct DB read (`.tmp/data.db`): the row persists exactly as submitted — `requester = attacker` (correctly locked to the real caller), `receiver = victim` (attacker's arbitrary choice), `listingId` = whatever string the attacker chose.

**Impact:** the requester's identity can't be spoofed (that part is safe), but an attacker can generate a real "Yeni Teklif" push notification to **any user of their choosing**, framed around a listing that may not even exist or may not belong to that "victim" — a targeted harassment/spam vector, and it creates a confusing/false "incoming offer" entry in the victim's teklifler_page for a listing they have no relationship to.

**Not a theoretical client-side edge case either**: the real Flutter client (`offers_store.dart`'s `_toStrapiOfferPayload`) **always** sends both `receiverEmail` and `receiverProfileId` when creating an offer. This means the server currently has **zero independent verification** that an offer's receiver is the listing's real owner, for any real-world offer, not just a hypothetically malicious one — it's enforced by client convention only, exactly the class of gap M1 closed for message sender identity.

**Recommended fix direction (not implemented — audit is read-only):** always call `resolveListingOwnerByAnyId` and either overwrite client-supplied receiver fields with the resolved owner, or reject the create if they disagree — mirroring how message sender identity now always wins over client input.

---

## 3. Systemic finding — the same permission-gap bug class, found 4 more times

This sprint has now found this **exact** bug shape (a custom route using `auth: { scope: [] }`, never added to `src/index.ts`'s `authenticatedActions` allowlist, silently 403ing for every real user since the route was added) **five times total**: `markRead` (messaging, fixed in M2), `logistics-load.metricLike`/`metricFavorite` (fixed pre-sprint), `deleteByThreadId` (messaging, found in M2, disclosed as BUG-M7, not fixed), and now, from a full systematic sweep of every route file using this auth pattern (22 files checked, cross-referenced against the full permissions array, **live-verified** with a real JWT — all four below returned Strapi's generic framework `403 Forbidden`, never reaching the controller):

| Action | Route | Severity | Notes |
|---|---|---|---|
| **`api::offer.offer.markSeen`** | `PATCH /offers/:offerId/seen` | Medium | In-scope for this audit. Offer "seen" tracking (mirrors messaging's read receipts) has never worked. Does not block core create/accept/reject/bargain flow. |
| **`api::notification.notification.markRead`** | `PATCH /notifications/:notificationId/read` | High | Out of Offer scope, but app-wide: marking ANY notification as read (offer, message, system) has likely never worked in production. |
| **`api::auth-flow.auth-flow.deleteAccount`** | `DELETE /auth/account` | High | Out of Offer scope. Account deletion is often an App Store/Play Store compliance requirement — worth prioritizing regardless of sprint order. |
| **`api::logistics-admin.*`** (7 actions: `access`, `loads`, `loadReview`, `vehicles`, `vehicleReview`, `offers`, `offerReview`) | `/logistics-admin/*` | High | Out of Offer scope. The entire logistics moderation/admin panel appears to be completely inaccessible — every action in this controller is missing from the allowlist, not just one. |

**Not fixed here** — this audit is read-only and these are outside Sprint 4's stated scope except `markSeen`. Flagging prominently because three of these (notifications, account deletion, logistics admin) are independently significant and easy to fix the same one-line way `markRead` was fixed in M2 — recommend a dedicated small follow-up sprint/patch for this whole class before Sprint 8's final UAT, since it's now clearly systemic rather than a one-off.

---

## 4. Findings requiring a product decision, not a code bug

- **Duplicate offers on the same listing**: no guard, client or server, prevents a requester from submitting a second, fully independent offer (new `offerId`) on a listing they've already made a pending offer on. The *intended* renegotiation path (bargain/counter-offer) correctly reuses the same offer row — but nothing stops a user from just tapping "make an offer" again instead. Is a second independent offer on the same listing by the same user desired (e.g., re-offering after rejection) or should it be blocked/merged into the existing one? Needs your call before this can be scoped as a bug or left alone.
- **Premium teklifler**: no premium-specific logic exists anywhere in the offer system today (backend or Flutter) — confirmed by grep, zero matches. Every user, premium or not, has identical offer capabilities. Is there a planned premium benefit here (unlimited offers, priority visibility, etc.) that was never built, or is this deliberately not a premium-gated feature? Needs a decision before it can be scoped.
- **Status-change notification is indirect and coupled to the chat channel**: `updateByOfferId` (accept/reject/bargain) creates **no notification row of its own**. The only notification either party gets about a status change comes from the offer-event chat message's own `message.afterCreate` → `notification.afterCreate` → FCM chain (per M4's audit). Combined with M4's own finding that a failed/queued offer-event message has no dedicated retry: **if that chat message fails to send, the status change (accept/reject/counter-offer) produces zero notification to the other party**, with no fallback. This was implicitly disclosed in M4 (§8) as "offer-event delivery isn't guaranteed," but this audit adds the concrete consequence: no chat message delivered = no notification of an accept/reject either, silently. Worth a direct `notification.notification` create inside `updateByOfferId` itself (decoupled from chat delivery) as a more robust fix than relying solely on the message side-channel — a product/priority decision for the fix phase.
- **`deleteByOfferId` has no status restriction**: either participant can delete an offer in ANY status, including `accepted` — erasing the record of an agreed transaction. May be intentional (users clearing their own history) or may warrant restricting delete to `pending`/`rejected` only. Minor, flagging for a decision rather than assuming either way.

---

## 5. Structural note (not currently a bug)

`offer-ownership.ts` (policy, runs on the stock `POST /offers` route) and `offer.ts`'s `create` action independently re-implement nearly identical requester/receiver resolution and self-offer validation. Both currently agree and are both safe (see §1), but this is duplicated logic in two places that could silently diverge if one is edited without the other — worth consolidating into one shared function during the fix phase, not urgent on its own.

---

## 6. Checklist coverage (your original 16 items)

| Item | Status |
|---|---|
| Teklif gönderme | Works; idempotent; requester spoof-proof. **BUG-OFFER-001** on receiver binding (§2). |
| Teklif alma | Works; participant-scoped read. |
| Teklif kabul | Works; receiver-only enforced server-side. |
| Teklif reddetme | Works; receiver-only enforced server-side. |
| Karşı teklif | Works; correctly reuses the same offer row, no duplicate-row risk. |
| Bildirim | Initial offer creation notifies; accept/reject/bargain does **not** directly (§4) — relies on chat side-channel with M4's known non-guaranteed delivery. |
| Teklif durumu | `pending/accepted/rejected/bargaining`, validated against an explicit allowlist server-side. |
| Duplicate teklif (same `offerId` retried) | Solid — idempotency lock + DB unique constraint + race handling. |
| Aynı ilana birden fazla teklif (separate offers) | No guard either way — product decision needed (§4). |
| Teklif sahibi doğrulaması | Requester: solid. Receiver: **not verified against real listing owner** (§2, BUG-OFFER-001). |
| Yetkilendirme | Solid for read/update/delete/accept/reject. `markSeen` unreachable (§3). |
| Premium teklifler | No premium logic exists at all — needs a decision (§4). |
| Teklif → Mesaj bağlantısı | Confirmed decoupled correctly (offer is source of truth, chat is a best-effort side effect) — but that side effect is also the *only* accept/reject notification path (§4). |
| Sayaçlar | `offerCount` fix exists but is **uncommitted** (§0) — currently broken on `main`/pushed branches. |
| Engagement | `offerCount` flows into `ListingEngagementStore`/card display once the WIP is committed; not otherwise audited in depth this pass. |
| Güvenlik (başkası adına teklif) | Requester identity: safe. Receiver identity: **not enforced** (§2) — the closest thing to "başkası adına" risk found, though it manipulates the *target*, not the *sender*. |

---

## DECISION

Not a PASS/FAIL gate (this was an audit, not a fix-verification pass) — but a clear go/no-go read for what comes next:

**Sprint 4 core (create/accept/reject/bargain/idempotency/authorization) is structurally sound** — better-built than messaging was pre-M1, honestly (idempotency and requester-identity protection already existed here from the start, unlike messaging's M1 gap). Two things need your explicit direction before a fix phase can be scoped:

1. **BUG-OFFER-001** (receiver identity, §2) — recommend fixing, same discipline as M1.
2. **The uncommitted `recountListingOffers` WIP** (§0) — recommend folding into the fix phase's counter work rather than leaving it stranded.

Everything in §3 (the 4-endpoint permission sweep) is **outside Offer scope** but too significant to sit on silently — recommend a short, separate, low-risk patch (same one-line-per-route fix as M2's `markRead`) before Sprint 8's final UAT, given `deleteAccount` in particular may be a compliance item.

§4's four items are genuine open questions, not bugs — need your product calls before they can be scoped as fix work or explicitly deferred.

**Not proceeding to any code changes.** Awaiting your direction on fix scope for Sprint 4, same as messaging's audit→approval→fix pattern.
