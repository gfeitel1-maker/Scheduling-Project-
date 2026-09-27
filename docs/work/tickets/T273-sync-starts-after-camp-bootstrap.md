---
title: "A freshly created camp starts syncing without a restart"
document_type: ticket
status: completed
created: 2026-09-26
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md]
archive_when: a device that creates a camp has a running Automerge sync node in that same session, without quitting and reopening the app, and a test fails if nothing re-invokes the startup path after bootstrap
---

# T273 — A freshly created camp starts syncing without a restart

## The defect

`startAutomergeSyncNodeIfEnabled` has exactly one call site, inside
`app.whenReady()` (`electron/main.js`). On a first run there is no camp yet —
`bootstrapCamp` refuses unless a mode has already been chosen, so a camp cannot
exist that early — and the function takes its no-camp-yet early return.

Nothing re-invokes it after `bootstrapCamp` succeeds. The device that just
created the camp therefore runs its entire first session with no sync node.
Quit and reopen and it works, because a camp now exists at launch.

T268 documented this in passing, in `startAutomergeSyncNodeIfEnabled`'s own
comment ("nothing calls this function again after bootstrap"), and used it to
justify leaving `automergeStartupAttempted` false on that path. That reasoning
was correct for T268's question (what the sidebar should say) and is orthogonal
to this one (when the node should start).

## Why it matters operationally

Pairing starts with one device creating the camp and displaying an 8-character
code for a second device on the same LAN to type. The device most likely to be
silently offline is therefore the Host that just created the camp and is
showing the code. The symptom presents as "pairing is broken" or "the other
device can't find me", which sends a reader to discovery, the code, or the
approval flow — none of which is at fault.

## Success predicate

A device that creates a camp begins syncing within that same session, without a
restart, exercised through the bootstrap path rather than by calling the
startup function directly.

## Non-goals

- No general redesign of the sync lifecycle. The question is narrowly *when*
  the node starts for a camp that did not exist at `app.whenReady()`.
- No change to what the sidebar displays — T268 shipped that and it is correct.
  This changes what is *true*, not what is *shown*.
- No retry loop or poller if a direct call at the right moment suffices.
- The join-by-code path is out of scope and has the same gap. The joining
  device's camp arrives at `joinAwaitData` (`electron/main.js:2306`), which is
  also after `app.whenReady()` has already returned on `!campId`, and nothing
  invokes the sync starter afterwards there either.

  **This ticket does not make pairing work.** Pairing is: the Host creates the
  camp and displays an 8-character code, a second device on the same wifi types
  it, the Host approves. T273 starts the Host's node in the session that
  created the camp. It does nothing for the joining device — so until the join
  route is fixed too, **both ends of a first pairing can still be silently
  offline**, on the single path this product is most often tested through.
  Fixed in the follow-up ticket alongside the db-swap paths below, not here.
- The db-swap paths are out of scope and remain broken. `reinitialize()`
  (`electron/main.js:2677`) and the backup-restore handler
  (`electron/main.js:2917`) rebuild handlers without the sync getters or
  `onCampBootstrapped`, so a camp bootstrapped after a project switch or a
  restore still will not sync until the app restarts. Fixing them correctly
  also requires stopping and nulling `automergeSyncNode` across the swap —
  the sync-lifecycle redesign the first non-goal above rules out. Recorded for
  the owner as a separate ticket; `electron/mainSyncStartupWiring.test.js` pins
  both sites as deliberately unwired so the gap cannot be quietly certified as
  covered.

## Known limit at close
The starter's decision logic is executed under Vitest as of T276 (`electron/sync/automerge/syncStarter.test.js`), which discharges what this ticket could not prove at merge. What remains unobserved is the real `app.whenReady()` composition in a packaged run: no unit test starts Electron. **Creating a camp on one machine and pairing a second without restarting has still not been done.** T274 closes the join-side half of the same defect.
