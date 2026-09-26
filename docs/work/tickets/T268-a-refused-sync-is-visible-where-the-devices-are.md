---
title: "A refused sync is visible where the devices are"
document_type: ticket
status: open
created: 2026-09-26
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
archive_when: a device that has refused to start sync says so in the sidebar's device row, survives a restart saying it, and no longer reports a healthy connection while it is true
---

# T268 — A refused sync is visible where the devices are

Two findings from the T267 review panel, ruled by the owner to be **one symptom
seen twice** and fixed together, surfaced in the device row at the bottom of the
left sidebar.

## The two halves

**A refusal nobody can see.** When a domain-state migration has run against a
camp that already holds a document, `startAutomergeSyncNodeIfEnabled`
(`electron/main.js`) refuses to start sync — correctly, because projecting the
document would undo the migration. It writes a `sync.blocked_by_domain_migration`
audit row and a `console.error`, then returns. No screen reads the audit table
and no director reads a console, so the refusal is invisible to the only person
who can act on it.

**The sidebar actively contradicts it.** `getSyncStatus()` returns
`{ mode: 'host', connected: true, state: 'host' }` for a Host device without
consulting anything. `mode` is set synchronously in `chooseMode()` before the
asynchronous node start, so `connected: true` is derived from an *intent* (a mode
was chosen) and reported as a *fact* (a node is running). During the exact window
sync is refused, a Host director's sidebar reads healthy.

The second half is the general defect: a caller that only special-cased the
refusal would leave the lie armed for the next one. So `getSyncStatus` reports
what is true about the node, and the refusal is one of the things that can be
true.

## What changed

- `electron/main.js` — `getSyncStatus()` no longer asserts `connected: true`
  from `mode`. It reports the durable refusal as its own state, and a Host whose
  sync node is not running says so rather than reading healthy.
- `electron/db/migrationDomainState.js` — the refusal decision is read from the
  same predicate the startup guard uses, so the guard and the status cannot drift.
- `src/components/layout/sidebarState.js` — `syncStatusLabel` gains the refusal
  as its highest-priority label, in the existing one-line slot beside Devices.
  No banner; no explainer.

## Non-goals

- No banner, no help copy, no onboarding.
- Not the resolution flow — making the state visible is the ticket.
- Not the domain-state marker itself (T267 owns that).
- Not a general sync-status redesign.
