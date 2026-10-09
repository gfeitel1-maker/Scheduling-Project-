---
ticket: T351
document_type: ticket
title: Lift the remaining setup-device-only ("mode === 'client'") gates to any admin on a trusted, non-revoked device
status: open
created: 2026-10-09
archive_when: "every mode==='client' refusal listed below is removed or STOP-reported; each lifted handler is reachable by an admin on a trusted non-revoked client-mode device and refused for a non-admin role and for a revoked/untrusted device, each proven red-first against the real IPC handler; no user-facing string says 'the device this camp was set up on' for a lifted behaviour; npm run verify green in CI"
task_class: security-auth
parent: ""
governing_docs: [docs/work/specs/2026-10-03-t332-client-admin-minting-design.md, SECURITY.md, docs/governance/standards/TESTING_STANDARD.md]
related_prs: []
related_tickets: []
---

# T351 — setup-device-only gates become admin-on-any-trusted-device

## Ruling (owner, 2026-10-09, in chat, relayed by the board keeper)

> lift the setup-device-only ("founding/host device") restrictions to ANY ADMIN device — same pattern as T332

## Gates in scope (found by the #794 retired-host sweep; line numbers at aee4b8a8)

| # | Handler (electron/main.js) | Line | Current rule |
|---|---|---|---|
| 1 | ingestCommit (import / replace) | ~519 | requireAuthorized `groups.import` (staff+admin) AND refuse if mode==='client' |
| 2 | ingestUndoHandler | ~696 | `groups.import` AND refuse on client |
| 3 | confirmAliasHandler | ~720 | `source_aliases.confirm` AND refuse on client |
| 4 | recordDeclinedSplitHandler | ~750 | `declined_two_row_splits.record` (staff+admin) AND refuse on client |
| 5 | denyDevice | ~1513 | `devices.approve` (admin) AND refuse on client |
| 6 | listOpenReconciliationDecisionsHandler | ~2179 | `open_reconciliation_decisions.read` AND refuse on client |
| 7 | dismissOpenReconciliationDecisionsHandler | ~2194 | `open_reconciliation_decisions.dismiss` AND refuse on client |
| 8 | getJoinCode | ~2748 | `devices.approve` AND refuse on client |
| 9 | setJoinWindow | ~2764 | `devices.approve` AND refuse on client |

No gate found that signs with `host_signing_key`; those references (main.js ~1028/1077/1149, localDb.js ~4351) are bootstrap/back-fill, not request gates — out of scope.

## Open owner question (escalated, not decided here)

`groups.import` and `declined_two_row_splits.record` are granted to **staff** (ADR 2026-08-28 Decision 2a; permissions.js). The ruling says "admin". Default implemented: the existing permission matrix stays the rule (mode-agnostic), so staff import keeps working wherever it already did and now also on a client device. If the owner instead wants these admin-only, that narrows ADR 2a and needs his explicit word.

## Outcome (Maker round 1)

- Lifted (rule is now the role permission plus a trusted, non-revoked device, any mode): 1 ingestCommit, 2 ingestUndo, 3 confirmAlias, 4 recordDeclinedSplit, 5 denyDevice, 6 list and 7 dismiss open reconciliation decisions. Tests: `electron/main.t351AdminDeviceLift.test.js`.
- STOP-reported, still setup-device-only: 8 getJoinCode, 9 setJoinWindow. A client-mode device (no `host_signing_key`) receives the pairing request and prompts the UI, but answers the joiner's login with a `local` token that `evaluateAuthenticate` refuses for the network, so the join cannot complete. Evidence: `electron/sync/automerge/clientHostedJoin.test.js`. The DeviceManager Approve/Deny buttons and Add-a-device panel stay gated in the UI for the same reason.
- Extra `mode === 'client'` hit at `login` (offline "join first" guard) is not a setup-device gate and was left alone.
- No role lacks `groups.import` / `declined_two_row_splits.record` (the users table admits only admin and staff), so gates 1, 2 and 4 pin "staff keep what they held" instead of a refused-role test.
- Caveat: source_aliases, declined_two_row_splits, open_reconciliation_decisions and the other ingest-side tables are device-local and never replicated, so a decision made on device B is not seen on device A.
