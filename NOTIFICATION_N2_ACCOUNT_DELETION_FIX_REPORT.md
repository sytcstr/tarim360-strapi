# TARIM360+1 — Notification N2 Targeted Fix: BUG-NOTIF-005 Account Deletion Cleanup

Scope: exactly one item — `NOTIFICATION_N2_FOLLOWUP_TRIAGE.md`'s single
FIX NOW finding. Backend only (`tarim360-strapi`), branch
`release/preflight-integration`. No schema change, no new notification
model, no changes to the N1 producers themselves. No merge to `main`,
no production deploy.

**Final decision: READY FOR ENGAGEMENT AUDIT.**

---

## Root cause, re-confirmed before fixing

`auth-flow.ts`'s `deleteAccount` notification cleanup filtered on
`{ownerProfileId, receiverEmail, requesterEmail}` only. Every producer's
actually-written fields were re-checked directly against the live code
(not assumed):

| Producer | Fields it writes | Caught by the old filter? |
|---|---|---|
| Message (`message/lifecycles.ts`) | `receiverEmail`/`receiverProfileId` | Yes |
| Admin broadcast (`admin-notification/lifecycles.ts`) | `targetEmail`/`targetProfileId` **and** `receiverEmail`/`receiverProfileId` (both set) | Yes, via `receiverEmail` |
| Support-reply (`support-ticket-message/lifecycles.ts`) | `targetEmail`/`targetProfileId` only | No |
| Offer created/accepted/rejected/countered (`offer.ts`) | `targetEmail`/`targetProfileId` only | No |
| Domain-event: listing/logistics-load/processed-product/profile favorite+like+comment (`notification.ts`) | `targetEmail`/`targetProfileId` only | No |

The two N1-introduced producers (offer status-changes, domain-events)
widened this gap's real footprint rather than narrowing it, since
neither existed at the time of the original forensic audit.

## Fix

One filter extension in `auth-flow.ts`'s `deleteAccount`:

```ts
deleted.notification = await deleteByFilter(
  'api::notification.notification',
  {
    $or: [
      { ownerProfileId: ownerId },
      { receiverEmail: email },
      { requesterEmail: email },
      { targetEmail: email },
      { targetProfileId: ownerId },
    ],
  },
);
```

`targetEmail`/`targetProfileId` added; the three pre-existing clauses
are untouched. Nothing else in the file, schema, or any producer was
touched — scope held exactly to the single approved item.

## Safety of the OR logic (explicitly re-verified)

- Both new clauses are plain equality matches against *this specific
  deleting user's own* `email`/`ownerId` — structurally identical to
  the three pre-existing clauses, so they carry the same "exact match
  only" safety property (no substring/prefix matching, no risk of
  over-deleting another user's row).
- Verified directly with a dedicated test (`another user's targetEmail/
  targetProfileId notification survives this account's deletion`): a
  bystander's notification, deliberately shaped to match the *new*
  fields, survives when a *different* account is deleted.
- Verified a fully unrelated notification (matching none of the five
  clauses at all) survives untouched.

## Tests

Added 7 tests to the existing
`tests/integration/auth-flow-delete-account.integration.test.ts`
(chosen over a new file to keep this fix colocated with the account-
deletion suite it belongs to):

1. A `targetEmail`-only notification is removed on deletion.
2. A `targetProfileId`-only notification is removed on deletion.
3. A **real** offer notification (created via the actual
   `offer.create` endpoint, not a hand-crafted row) is removed when the
   receiver deletes their account.
4. A **real** domain-event notification (created via the actual
   `POST /notifications/domain-event` endpoint) is removed when the
   target owner deletes their account.
5. A message-shaped (`receiverEmail`) notification's cleanup is
   unchanged — proves the pre-existing behavior wasn't altered.
6. Another user's `targetEmail`/`targetProfileId` notification survives
   this account's deletion.
7. A fully unrelated notification survives.

All 11 tests in the file pass (4 pre-existing + 7 new).

## Validation

- `npx tsc --noEmit` — clean.
- `npm test` (unit) — 31/31 passing.
- `npm run test:integration` — **290/290 passing** (283 before this fix
  + 7 new, 0 regressions across the entire suite).
- `npm run build` — clean.
- `git diff --check` — clean.

Flutter: no code change required or made — this is a backend-only data-
retention fix; the client has no notification-deletion logic of its own
to touch.

## Regression, explicitly re-verified via the full suite run (not assumed)

- **deleteAccount permission fix** — `an authenticated user can delete
  their own account -> 200...` and the other 3 pre-existing tests in
  this same file still pass unchanged.
- **N1 domain-event** — the new domain-event regression test in this
  phase (#4 above) exercises the real endpoint end-to-end and passes;
  the full N1 suite (`notification-n1-security-fix.integration.test.ts`,
  24 tests) is part of the 290 and passed in this run.
- **Offer notification** — the new offer regression test (#3 above)
  exercises real `offer.create` end-to-end; `offer-receiver-ownership.
  integration.test.ts` (O1) and the N1 offer tests both remain in the
  290 passing.
- **notification.markRead** —
  `notification-mark-read.integration.test.ts` remains in the 290
  passing, untouched.
- **FCM token ownership** — the N1 FCM tests
  (`registerPushToken`'s cross-profile eviction) remain in the 290
  passing, untouched by this change.

## Commit

Backend (`tarim360-strapi`):
- `4760da3` — `fix(auth): remove notification PII on account deletion`

Pushed to `release/preflight-integration` only. No merge to `main`, no
production deploy.

## Decision

**READY FOR ENGAGEMENT AUDIT.**

With BUG-NOTIF-005 closed, every item from
`NOTIFICATION_SYSTEM_RELEASE_FORENSIC_AUDIT.md` is now either fixed
(BUG-NOTIF-001/002/003 in N1, BUG-NOTIF-005 here, BUG-NOTIF-009 as a
side-effect of N1), correctly reclassified as not-a-bug or lower-
severity-than-originally-assessed with direct evidence
(BUG-NOTIF-004, BUG-NOTIF-006), or deferred as a genuinely low-severity,
non-blocking item (BUG-NOTIF-010 through 014). No open CRITICAL/HIGH/
MEDIUM remains. The Notification system is closed from a release
standpoint.

Per the mandate: stopping here. Not proceeding to the Engagement Final
Audit automatically — awaiting your go-ahead.
