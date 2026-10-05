# TARIM360+1 — SPRINT 3 — MESSAGING FIX PHASE M2: READ/SEEN + UNREAD SYSTEM

Branch: `fix/release-messaging-read-state` (both repos, created from `fix/release-messaging-core`'s HEAD)
Backend repo: `C:\projeler\tarim360-strapi`
Flutter repo: `C:\projeler\tarim360`
References: `MESSAGING_RELEASE_FORENSIC_AUDIT.md`, `MESSAGING_M1_M3_CORE_FIX_REPORT.md`, `MESSAGING_M1_M3_POST_COMMIT_VERIFICATION.md`

---

## 1. What was actually broken

The read-only reverify surfaced a more severe starting point than "double-tick is fake":

1. **`markRead` (`PATCH /conversations/:threadId/read`) was unreachable in production.** The route uses `auth: { scope: [] }`, which still requires the action to be explicitly granted to the authenticated role in `src/index.ts`'s bootstrap allowlist — and it never was. Every real markRead call 403'd for every user, always, since this endpoint was added. This is the same class of gap previously found and fixed for the logistics-load metric routes (`api::logistics-load.logistics-load.metricLike`/`metricFavorite`), confirmed live while writing this phase's integration tests (a valid JWT for a real thread participant still got a bare Strapi `"Forbidden"`, not this controller's own error message).
2. **BUG-M6, confirmed:** even if reachable, `markRead` stamped `readAt`/`readBy` on *every* message in the thread, including the caller's own outgoing ones. Once fixed, the double-tick UI would have shown "read" the instant either participant opened the thread once — a false positive on day one.
3. **`thread.unreadCount` (the stored scalar) was structurally incapable of being correct.** It was never incremented on message send (`upsertThread` always writes whatever the client sends, or `0`), and `markRead` reset it to `0` on every call. A single scalar also cannot hold two participants' independent counts at once.
4. **The Flutter client's badge value was consequently always reset to 0 or wrong.** `MessagesStore._replaceThreadsFromRemote`'s merge logic prefers the freshly-parsed remote thread over the local one in the common case — so even the badge value a user briefly saw client-side got overwritten by the server's always-0 value on every periodic refresh.
5. **`ChatMessage` had no read field at all** — the double-tick icon in both chat pages was `if (m.me) Icon(Icons.done_all, ...)`, unconditionally, for any outgoing message. `m.me` was doing double duty as both "mine" and a fake "read," which the mandate explicitly forbids.
6. **`messages_page.dart` fired `markRead` twice per conversation open** (once pre-navigation, once again in `MessageChatPage.initState`) — harmless once markRead is idempotent, but redundant.

No code changes were made to M1/M3/M5 in this phase; only the above.

---

## 2. Backend read state source-of-truth

**Canonical field: `message.readAt`** (datetime, per message). A message is unread by user `V` iff `V` did not send it AND `readAt` is empty. This single field now drives both:
- The double-tick UI (Flutter reads it directly per message).
- Unread counts (computed, not stored — see below).

`message.readBy` (json, actor → timestamp) is still written alongside `readAt` for potential multi-party/audit use, but is never the deciding signal — there is exactly one read semantic, not two, per the mandate's explicit instruction.

`thread.readReceipts`/`thread.lastReadAt` remain as the "when did this user last open this conversation" watermark (unchanged purpose, still written by markRead) — they are not used for unread-count computation, only `message.readAt` is.

`thread.unreadCount` (the stored scalar column) is no longer written or trusted for correctness. It still exists in the schema (no migration in this phase) but every response Flutter actually consumes (`mine`, `myMessages`) now overrides it with a freshly computed, per-viewer value before sending.

### `computeUnreadCountsByThread` (new, shared by `mine` and `myMessages`)
For the calling user, fetches messages across the requested `threadIds` filtered to `readAt: null` (a cheap, small backlog query — read messages are never fetched for this), excludes any message the caller sent themselves (`isSamePerson` against `senderEmail`/`senderProfileId`), and counts what's left, per thread. Always `>= 0` by construction (it is a `count()`), self-heals on every refetch/app-restart (no counter to drift out of sync), and cannot leak between threads (grouped by `threadId`).

### `markRead` (fixed)
1. Participant check unchanged and already correct (`userFilter` on the `THREAD_UID` lookup — a non-participant gets no thread row → `403`).
2. Updates `thread.lastReadAt`/`readReceipts[actor]` (watermark) — unchanged behavior, still fires on every call.
3. **Fixed (BUG-M6):** the per-message update loop now only touches messages where `sender != caller AND readAt is still empty`. An already-read message's `readAt` is left untouched — repeat `markRead` calls are a true no-op at the message level; only the watermark advances.
4. Client-supplied `readBy`/actor-key fields in the request body are not read at all — the actor key is always `actorForUser(ctx.state.user)`, i.e., server-derived from the JWT. Proven by a dedicated test (spoofed `readBy` in the body has zero effect on the persisted `readReceipts`).

---

## 3. Flutter read state source-of-truth

`ChatMessage` gained `readAt` (nullable `DateTime`, parsed from the message row's `readAt`) and `isRead` (`readAt != null`). Populated at both places a message row is turned into a `ChatMessage`: the thread-list message-history loop in `_refreshThreadsRemote`, and `_refreshThreadMessagesRemote`'s per-thread message loop. A locally-constructed optimistic message (just sent) defaults `readAt: null` — correct, since it cannot have been read yet.

New shared helper `outgoingTickIcon(ChatMessage m)` (in `message_models.dart`) replaces both chat pages' independent, identical `if (m.me) Icon(Icons.done_all, ...)` blocks:
- incoming (`!m.me`) → `null`, no icon (unchanged — this was already correct).
- outgoing + unread → `Icons.done` (single tick).
- outgoing + read → `Icons.done_all` (double tick).

No third "delivered" state was invented — the schema has none, and the mandate explicitly forbade fabricating one.

`unreadCount` parsing on the Flutter side needed **no changes**: `_fromThreadRow`/`_fromMessageRow` already read `unreadCount`/`unread` from the row via `_pickInt`, and `MessagesStore.totalUnread` already sums it across all threads. The bug was entirely that the backend always sent `0`; now that it sends the real, computed value, the existing parsing and the existing merge logic (`_replaceThreadsFromRemote`) both work correctly without modification.

---

## 4. markRead lifecycle (Flutter)

Single trigger: `MessageChatPage.initState` → `MessagesStore.I.markRead(threadId)` (a `WidgetsBinding.instance.addPostFrameCallback`, unchanged). `markRead` synchronously zeroes the local `unreadCount` for instant UI feedback, then fire-and-forgets `_markThreadReadRemote` → `StrapiService.markConversationRead` → `PATCH /conversations/:threadId/read`.

The redundant second call site — `messages_page.dart`'s `_openChat`, which called `markRead` again *before* navigating to the chat page — is removed. `initState` runs exactly once per `State` lifetime (a Flutter framework guarantee, never re-invoked on rebuild), so "one conversation open, one mark-read" is now true by construction, not by coincidence.

---

## 5. Unread count model

Per-conversation: `count(messages in thread where sender != me AND readAt is empty)`, computed fresh on every `GET /conversations/mine` / `GET /conversations/messages/mine` response. Global (bottom-nav badge): `MessagesStore.totalUnread`, an unchanged plain sum of each thread's (now-correct) `unreadCount` — no Flutter change was needed here since the bug was entirely upstream.

Verified behaviors (backend integration tests): `0→1` on first message, `1→2` on a second, `→0` on markRead, unaffected by an unrelated conversation, never negative (structurally impossible — it's a `count()`), never incremented by the sender's own message, and survives an independent refetch (proving persistence, not an in-memory artifact of a single request).

---

## 6. The old fake `m.me` behavior

Before this phase: `if (m.me) Icon(Icons.done_all, ...)` — any outgoing message showed a colored double-tick unconditionally; incoming messages showed nothing (that half was already correct). `m.me` never meant "read"; it only ever meant "this message is mine." The rendering conflated the two. Fixed by introducing a real `isRead` signal on `ChatMessage` and consuming it through `outgoingTickIcon`, which is the only place either chat page decides what icon to show.

---

## 7. Sender refresh behavior

When A sends and B later reads: A's next `GET /conversations/messages/mine` (the primary thread-list refresh path — `myMessages`, preferred over `mine` when message rows are non-empty) or `GET /conversations/:threadId/messages` (when A has the chat open) returns the SAME message rows, now carrying a non-null `readAt` on the ones B read. Flutter's existing merge logic (`_replaceThreadsFromRemote`, `_mergeRemoteChatHistory`) already de-duplicates and overlays remote state onto local; since `readAt` is now correctly parsed into each `ChatMessage`, A's UI flips to double-tick on the next poll/refresh without any special-casing — the old local `ChatMessage` is not itself "un-echoed," but the remote-driven refresh path (which A's chat page already polls every 10s while open, and which fires on next `mine` fetch otherwise) supersedes it, since `_shouldKeepLocalThread`'s logic only prefers local state when local has unsynced/newer content, which is not the case here (the message is already synced, just read). Verified server-side by the "read state survives a fresh fetch" test, which proves persistence; the client-side rendering of an already-parsed `readAt` was verified by the `ChatMessage.isRead`/`outgoingTickIcon` unit tests.

---

## 8. Security results

- Non-participant `C` cannot `markRead` a thread they're not in (`403`, existing `userFilter` scoping — regression-tested, not newly built).
- `C` cannot even see a thread they're not in inside their own `mine` list (implicit — same filter).
- Unauthenticated `markRead` → `403` (Strapi framework convention, consistent with every other route in this codebase).
- A client-supplied `readBy`/actor-key override in the `markRead` request body has zero effect — the actor identity is always server-derived from `ctx.state.user`; the handler never reads an identity field from the body (it only reads `readAt`, a timestamp, which is low-stakes and already an established pattern in this codebase).
- No new IDOR surface introduced: `computeUnreadCountsByThread` only ever operates on `threadIds` already scoped to the caller by `userFilter` in `mine`/`myMessages` — it is never given an arbitrary/unvalidated thread list.

---

## 9. Test counts

**Backend** (`conversation-read-unread.integration.test.ts`, new, port 14166): **10/10 passing.** Combined with the M1/M3/M5 suite, full integration run: **182/182 passing**, exit 0, no flaky/retry indicators. Unit: **31/31**. `tsc --noEmit`: clean. `npm run build`: succeeds. `git diff --check`: clean.

**Flutter** (`messages_read_unread_test.dart`, new): **12/12 passing.** Full suite: **225/225 passing**, exit 0. `flutter analyze`: 2 issues, both pre-existing and unrelated (`logistics_models.dart` unused-element warnings, a file untouched by this phase). `git diff --check`: clean.

Clean-checkout worktree validation (isolated `git worktree`, tracked-only) passed in both repos against the final commit on `fix/release-messaging-read-state`.

---

## 10. Commit hashes

**Backend:**
```
99a9744 fix(messaging): enforce authenticated sender identity        <- M1/M3/M5 (prior phase)
4c67efd fix(messaging): make conversation creation race safe          <- M1/M3/M5 (prior phase)
a745ec9 test(messaging): add backend send and ownership coverage      <- M1/M3/M5 (prior phase)
a79cf1c fix(messaging): persist participant-specific read state       <- M2
727da87 fix(messaging): make unread counts authoritative              <- M2
80e3cf7 test(messaging): add read and unread integration coverage     <- M2
```

**Flutter:**
```
1eb8c74 fix(messaging): simplify participant normalization for send   <- M1/M3/M5 (prior phase)
86c4f9b test(messaging): add send flow coverage                       <- M1/M3/M5 (prior phase)
efec897 fix(messaging): render server-backed read receipts            <- M2
9c59c21 fix(messaging): synchronize unread state                      <- M2
5ffa53e test(messaging): add read and unread UI coverage              <- M2
```

Both `fix/release-messaging-core` M1/M3/M5 commits (`a79cf1c` onward is the split point) and this phase's M2 commits share the branch `fix/release-messaging-read-state`, created from `fix/release-messaging-core`'s HEAD. Both `conversation.ts` two-commit splits (M1/M5 in the prior phase, and this phase's "persist read state" / "authoritative unread counts" split) were verified byte-identical against their original combined diffs before committing — no fix content was lost or reordered by the split.

Pushed: **branch only**, both repos. `main` untouched, no production deploy.

| | Backend | Flutter |
|---|---|---|
| Branch | `fix/release-messaging-read-state` | `fix/release-messaging-read-state` |
| HEAD | `80e3cf7` | `5ffa53e` |
| Commits this phase | 3 | 3 |
| origin sync | 0 ahead / 0 behind | 0 ahead / 0 behind |

---

## 11. M6 status

**Closed, as a natural consequence of M2** (not a separate cleanup pass, per the mandate's instruction). The fix was scoped to exactly what M2 required: `markRead`'s message-mutation loop now excludes the caller's own messages and already-read messages. No broader `markRead` refactor was performed.

---

## 12. Scope-adjacent findings, disclosed but not fixed

- **`api::conversation.conversation.deleteByThreadId` has the identical missing-permission gap** as `markRead` had (also absent from the `authenticatedActions` allowlist in `src/index.ts`) — meaning Flutter's conversation-delete feature (`MessagesStore.deleteThreads` → `StrapiService.deleteThread`) has likely never worked in production either. This is unrelated to read/unread and was **not fixed** in this phase (out of scope). Flagging for a future phase.
- `thread.unreadCount` (the stored scalar column) is now permanently vestigial — never written meaningfully, never trusted. No schema migration was made to remove it in this phase (would be a larger, unrelated change); it is simply not part of the API's read-state contract anymore.

---

## 13. Remaining scope

- **M4** (retry/pending/queued-message delivery) — untouched.
- **BUG-003A** (premium branding on messages) — untouched.
- **M6** — closed (see §11).

---

## DECISION

# READY FOR M4

M2 core is closed: read/seen state is now real, server-persisted, participant-scoped, and idempotent; unread counts are computed correctly and cannot go negative or leak across conversations; the double-tick UI reflects genuine backend state with no invented "delivered" state; markRead fires exactly once per conversation open. All verification (backend 182/182 integration + 31/31 unit, Flutter 225/225, both clean-checkouts) passed. `offer.ts` WIP and all other unrelated files remain untouched throughout.

**Stopping here per instruction — not proceeding to M4 or premium branding without explicit authorization.**
