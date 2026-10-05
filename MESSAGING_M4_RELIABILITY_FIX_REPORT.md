# TARIM360+1 — SPRINT 3 — MESSAGING FIX PHASE M4: RETRY / PENDING / OFFLINE RELIABILITY

Branch: `fix/release-messaging-reliability` (both repos, created from `fix/release-messaging-read-state`'s HEAD)
Backend repo: `C:\projeler\tarim360-strapi`
Flutter repo: `C:\projeler\tarim360`
References: `MESSAGING_RELEASE_FORENSIC_AUDIT.md`, `MESSAGING_M1_M3_POST_COMMIT_VERIFICATION.md`, `MESSAGING_M2_READ_UNREAD_FIX_REPORT.md`

---

## 1. Old failed-send behavior (confirmed by read-only reverify)

- **No per-message delivery state existed at all.** `ChatMessage` had only `me`/`text`/`time`/`readAt` (post-M2) — nothing tracked whether an individual outgoing message was in flight, delivered, or failed.
- **A failed send was invisible.** `message_chat_page.dart`/`offer_chat_page.dart`'s `_send()` only ever added a `ChatMessage` to the visible history **after** a successful network round trip. On failure, nothing was added — the user's typed text disappeared from the chat with only a transient SnackBar as evidence it was ever attempted.
- **The store actively erased the attempt.** `MessagesStore._remoteSendMessage` snapshotted the thread before the optimistic update and, on failure, restored that snapshot verbatim (`threads[currentIdx] = previous`) — the conversation list reverted as if the send had never happened.
- **No retry existed anywhere** for a normal message. The only "recovery" was the user manually retyping and hitting send again.
- **Offer/system-event messages (M4 audit finding, reconfirmed on current HEAD):** `syncOfferEventFromCurrentUser` is called fire-and-forget (`unawaited(...)`) from six call sites in `offers_store.dart` (offer create/accept/reject/bargain). On failure it sets the thread's `lastMessageSyncState = DeliverySyncState.queued` and returns `false` — but the return value is discarded by every caller, and nothing ever retries. The state is real and already rendered (see §3), but genuinely permanent until the user sends a new message in that thread (which re-triggers a fresh `upsertThread`, not a retry of the stuck event).
- **No idempotency existed anywhere in the send path.** Nothing prevented a client-side retry (manual or accidental double-tap) from creating two real messages in the database.

---

## 2. New delivery-state model

**`MessageDeliveryStatus` (Flutter, local-only):** `sending | sent | failed`, on `ChatMessage.deliveryStatus` (mutable, defaults to `sent` so every pre-existing/historical/incoming construction site is unaffected). Deliberately kept separate from `ChatMessage.isRead` (server-backed, M2) — a message can be `sent` without being `read`, and read state only ever applies to something the server already has:

```dart
deliveryStatus = sending | sent | failed   // local, this device, this attempt
isRead = readAt != null                    // server-confirmed, the other participant
```

No `pending`/durable-queue state was added — see §5 for why a `sending → sent/failed` model is sufficient for this phase's release-safety bar.

**`outgoingTickIcon`** now also gates on `deliveryStatus`: only a `sent` message shows a tick at all (single while unread, double once read); `sending` shows nothing (nothing to report yet); `failed` shows nothing (it has its own dedicated error/retry row instead of a misleading checkmark).

---

## 3. Optimistic send / preserve-on-failure

Both chat pages now construct the `ChatMessage` (status `sending`) and add it to both the page's local `msgs` and `MessagesStore`'s `_chatHistory` **before** the network call. On completion, the **same object instance** flips to `sent` or `failed` in place — no second bubble is ever created, and a failed message is never removed. A tappable `Icons.error_outline` + "Gönderilemedi • Tekrar dene" row appears under any `failed` outgoing bubble.

`MessagesStore._remoteSendMessage` no longer reverts the thread to its pre-attempt snapshot on failure: the resolved participants/preview stay (so a retry doesn't need to re-resolve them), and the thread is marked `DeliverySyncState.queued` instead of "as if nothing happened" — the conversation list (`messages_page.dart`, which already renders `deliverySyncIcon`/`deliverySyncColor` per thread) reflects the unsent state too.

---

## 4. Idempotency (operationId)

Reused the **existing, proven** `operation-idempotency.ts` pattern (already battle-tested by `listing-comment`/`listing-share`, with its own dedicated unit tests) rather than inventing a new mechanism, per the mandate's explicit instruction to check for and reuse an existing one first.

- **Backend:** `message` gained `operationId` (unique, optional) and `payloadFingerprint`. `POST /conversations/message` now: validates the client-supplied `operationId` (UUID format; malformed or absent is silently ignored, not rejected — the field is optional for backward compatibility), computes a fingerprint of `{threadId, text, senderProfileId, senderEmail, receiverProfileId, receiverEmail}`, and resolves via `resolveOperation`:
  - **new** → proceeds to create, storing `operationId`/`payloadFingerprint`.
  - **duplicate** (same id, same fingerprint) → returns the **original** message + thread, no new row.
  - **conflict** (same id, different fingerprint) → `400`, rejected outright — reusing an id for a different message is never silently accepted.
  - A genuine concurrent race on `create` is caught and re-resolved to the winning row instead of surfacing a raw unique-constraint error (same pattern as M5's thread-creation race fix).
- **Flutter:** `newOperationId()` generates a UUID v4 locally (no new package dependency — `uuid` is only transitive here; implemented directly against the same format the backend validates). Generated once per logical send, reused verbatim on retry, threaded through `sendMessage` → `_remoteSendMessage` → `_syncOutgoingMessageToStrapi` → the actual request payload.
- **Client-side duplicate prevention (a step beyond the backend guarantee):** the optimistic local bubble and the server-echoed row (picked up by the next poll/refresh) are two separate objects for a while. The history-merge dedup (`_dedupKeyFor`, used by both `_mergeRemoteChatHistory` and the thread-list message-history loop) now keys on `operationId` when present, falling back to the old `me+time+text` composite key for historical rows created before this phase. The two objects converge into one bubble instead of appearing twice.

---

## 5. Offline behavior

No connectivity-monitoring package exists in this codebase (confirmed: no `connectivity_plus` or equivalent in `pubspec.yaml`, and no centralized network-state store anywhere in `lib/`). Per the mandate's own explicit fallback guidance, this phase does **not** introduce one. Offline send behaves identically to any other network failure: `sending → failed`, visible, tappable retry. This is the mandate's stated minimum-acceptable release behavior.

**Restart persistence — explicitly scoped out, disclosed as requested:** a `failed` message's bubble is in-memory only (page-local `msgs` + `MessagesStore._chatHistory`, never persisted to disk). If the app is killed while a message is `failed` (not yet retried), that specific failed bubble does not survive restart — the user would need to retype and resend. This is a genuine product-requirements question, not a technical default I'm making silently: if "a failed message must survive app restart" is a real requirement, it needs a local persistence layer (e.g., a pending-outbox table) that does not exist anywhere in this codebase today, which is a materially larger change than this phase's mandate. Flagging for explicit decision before the next phase.

---

## 6. Manual retry

`_retry(ChatMessage m)` (both chat pages, near-identical): guarded by `if (m.deliveryStatus == sending) return;` — a double-tap on "Tekrar dene" while a retry is already in flight is a no-op, satisfying "aynı network request" at the client-request level. Reuses the exact same `text` and `operationId` as the original attempt, so a request that DOES reach the server twice (e.g., the first attempt's response was lost but it actually succeeded) still resolves to one message via the backend's idempotency check (§4), not a client-side guard alone.

---

## 7. Automatic retry — not implemented, disclosed as technical debt

Per M4.6's own instruction to verify necessity first: no automatic retry (bounded or otherwise) was implemented. Reasoning:
- No connectivity/network-state infrastructure exists to time a sensible automatic retry against (see §5).
- The mandate's own fallback is explicit: "manuel retry ile release-safe çözüm tercih et ve durable automatic retry'ı teknik borç olarak raporla" when automatic retry would grow the architecture.
- The one property that WOULD be dangerous with naive automatic retry — retrying a `400`/`401`/`403` (auth/participant/validation) forever — is moot because there is no automatic retry loop to misbehave. If automatic retry is added in a future phase, the existing error classification (`strapi_service.dart`'s `_extractError`, already status-code-aware since M3) already distinguishes these from `5xx`/timeout, so that future work has the classification it needs already in place.

**Disclosed technical debt:** bounded automatic retry (e.g., 5xx/timeout only, 2–3 attempts, exponential backoff) is not implemented. Manual retry is the only recovery path this phase ships.

---

## 8. Offer/system-event messages (BUG-M4 from the forensic audit)

Confirmed on current HEAD (§1) and closed to the degree the mandate specifies ("ya normal mesaj retry pipeline'ına girsin ya da explicit failed state alsın" — either/or, not both required):
- **Now idempotent:** `syncOfferEventFromCurrentUser` generates a fresh `operationId` per attempt and passes it through the same `_syncOutgoingMessageToStrapi` path a normal message uses — if the underlying request is ever retried (now or by future work), it cannot double-post.
- **Already an explicit, visible state:** the thread's `DeliverySyncState.queued` on failure was already rendered as a real icon (`deliverySyncIcon`/`deliverySyncColor`) next to the conversation preview in `messages_page.dart` — confirmed by reading that page, not assumed. A failed offer-event message is not silently lost; it's a visibly different icon in the conversation list.
- **Not added this phase:** a dedicated "retry this queued offer-event message" UI action. There is no existing UI pattern for retrying a thread-level (as opposed to message-level) delivery state anywhere in the app, and building one is a real, standalone feature, not a bug fix. Disclosed here rather than built ad hoc.
- **Confirmed unchanged (as required):** the offer's own business transaction (`strapi.createOffer(...)` / accept/reject/bargain) completes and is fully committed **before** the chat-event message is ever attempted, and the chat-event's own failure/success has zero effect on the offer record. The offer stays the sole source of truth, exactly as before this phase.

---

## 9. Duplicate prevention — summary

| Layer | Mechanism | Proof |
|---|---|---|
| Backend DB | `message.operationId` unique constraint + `resolveOperation` | conversation-send-retry.integration.test.ts: 3x identical retry → 1 row; concurrent race → 1 row |
| Backend semantics | Different body under reused operationId → `400`, not silently merged | same suite: conflict test |
| Client UI | `_dedupKeyFor` prefers `operationId` over the old composite key | messages_reliability_test.dart (unit-level: key construction proven via `outgoingTickIcon`/model tests); full merge behavior is code-reviewed, not independently unit-testable without a network seam (disclosed) |
| Client request | Retry button guarded by `deliveryStatus == sending` | code path, mirrors the same guard pattern proven for the original send in M3 |

---

## 10. Test counts

**Backend** (`conversation-send-retry.integration.test.ts`, new, port 14167): **8/8 passing.** Combined with M1/M3/M5/M2's suites, full integration run: **190/190 passing**, exit 0. Unit: **31/31**. `tsc --noEmit`: clean. `npm run build`: succeeds. `git diff --check`: clean.

**Flutter** (`messages_reliability_test.dart`, new): **12/12 passing.** Full suite: **237/237 passing**, exit 0. `flutter analyze`: 2 issues, both pre-existing and unrelated (`logistics_models.dart`, untouched by this phase). `git diff --check`: clean.

Clean-checkout worktree validation (isolated `git worktree`, tracked-only) passed in both repos against the final commit on `fix/release-messaging-reliability`.

---

## 11. Commit hashes

**Backend:**
```
7a6fc78 feat(messaging): make message retries idempotent
8402e90 test(messaging): add retry and duplicate-send coverage
```

**Flutter:**
```
972eacc fix(messaging): preserve failed outgoing messages
f934f65 feat(messaging): add safe retry flow
ae915d9 test(messaging): add delivery-state and retry coverage
```

**Deviation from the exact commit plan, disclosed per this project's established discipline ("yapay bölme gerekiyorsa yapma; sapmayı raporla"):** the mandate specified two Flutter *fix* commits — "preserve failed outgoing messages" and "add safe retry flow" — as if independently separable. On inspection they genuinely were separable (unlike a case requiring an artificial line-split): `deliveryStatus`/the no-rollback fix/the non-interactive failed indicator are functionally complete and independently correct without `operationId`/retry; `operationId`/dedup-by-id/the tappable retry action build on top. Both were reconstructed as true two-stage edits (revert → reapply stage 1 → commit → reapply stage 2 → commit) and verified: `flutter analyze` clean at each stage, full test suite green after both, and the combined two-commit diff checked against the original single-pass implementation with only cosmetic differences (comment wording, line-wrapping, one inline-vs-local-variable style choice) — no functional content lost or reordered. This is disclosed as a difference from the backend's byte-identical reconstructions (M1/M5, M2) purely because the two Flutter stages were re-typed by hand rather than mechanically split from one diff; substance was verified equivalent via analyze + the full 237-test suite, not via byte comparison.

Pushed: **branch only**, both repos. `main` untouched, no production deploy.

| | Backend | Flutter |
|---|---|---|
| Branch | `fix/release-messaging-reliability` | `fix/release-messaging-reliability` |
| HEAD | `8402e90` | `ae915d9` |
| Commits this phase | 2 | 3 |
| origin sync | 0 ahead / 0 behind | 0 ahead / 0 behind |

---

## 12. BUG-M7 — Conversation delete route permission missing

**Found while reverifying the M2-era permission gap pattern, out of scope for M4, not fixed this phase per explicit instruction.**

`api::conversation.conversation.deleteByThreadId` uses `auth: { scope: [] }` (route config) but, like `markRead` before its M2 fix, was never added to the `authenticatedActions` allowlist in `src/index.ts`. This means `DELETE /conversations/:threadId` — used by Flutter's `MessagesStore.deleteThreads` → `StrapiService.deleteThread` (the "Sohbeti Sil" action in both chat pages) — has almost certainly 403'd for every real user since this route was added, identical in nature to the markRead bug M2 fixed.

**Severity: Medium, not a release blocker for messaging-core.** It does not affect send, receive, read state, or retry — the entire scope of Sprint 3 so far. It affects one specific, secondary feature (deleting a conversation from the device), which likely silently fails today (the delete button probably shows a "Sohbet silinemedi" error, since `deleteThreads` returns `false` on non-200). Not a data-loss or security risk — the opposite, if anything (a broken delete means conversations are über-preserved, not lost). Recommend fixing in the same manner as `markRead` (one line in `src/index.ts`'s `authenticatedActions` array) in a dedicated small follow-up, verified with its own regression test, rather than folding it into this report's already-large diff.

---

## 13. Remaining scope

- **BUG-003A** (premium/partner branding on messages) — untouched, unrelated to this phase.
- **BUG-M7** (conversation delete permission) — found, disclosed, not fixed (§12).
- **Durable automatic retry** — disclosed as technical debt (§7).
- **Failed-message restart persistence** — explicitly flagged as a product-requirements question, not decided unilaterally (§5).

---

## DECISION

# READY FOR MESSAGING FINAL PHASE

M4 core is closed: a failed message is never silently lost (visible, tappable retry), retries — manual or accidental — cannot create duplicate messages (backend-enforced, not just client-side), offline/network failures degrade to the same safe `failed` state rather than a fake "sent," and offer/system-event messages are both idempotent and already visibly flagged when stuck. All verification (backend 190/190 integration + 31/31 unit, Flutter 237/237, both clean-checkouts) passed. `offer.ts` WIP and all other unrelated files remain untouched throughout.

Messaging now has two items left per the user's own framing: **premium/partner branding (BUG-003A)** and **BUG-M7 (delete permission)** — plus the two-real-user end-to-end test to formally close Sprint 3.

**Stopping here per instruction — not proceeding to BUG-003A or BUG-M7 without explicit authorization.**
