---
title: "A device that joins a camp by code starts syncing without a restart"
document_type: ticket
status: completed
task_class: database-sync
date: 2026-09-26
created: 2026-09-26
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md]
related_tickets: [docs/work/tickets/T211-wire-rendezvous-into-discovery-path.md]
program: relay-sync
archive_when: "A device that joins a camp by code has a running persistent Automerge sync node for the rest of that session with no restart, proven by a behavioural test that drives the real join path and asserts the persistent starter runs after the camp materializes; the db-swap sites (main.js reinitialize/restore) are untouched and the sync-startup wiring guard is green including a pinned invariant for the join hook"
---

# T274 — a joined camp starts syncing without a restart

## The defect (mirror of T273, on the join path)

`startAutomergeSyncNodeIfEnabled` has one call site, at `app.whenReady()`
(`electron/main.js`). On a device that JOINS a camp by code, no camp exists at
`whenReady()` — the camp arrives later, via the join flow — so the starter takes
its no-camp early return and a `finally` latches the startup-attempted flag
(T268's `getAutomergeStartupAttempted`). The camp then materializes through
`joinAwaitData` (`electron/main.js:2306`) → `activeJoin.waitForCamp()`
(`electron/sync/automerge/joinSession.js:386`), which writes the `camps`
singleton row. **Nothing re-invokes the starter after that**, so the joining
device runs the rest of its session with no persistent sync node and never syncs
until restart.

T273 (merged `0ce8c7ee`, #559) fixed the equivalent on the HOST/bootstrap end:
`bootstrapCamp` now invokes an injected `onCampBootstrapped` callback as its last
step, wired at the initial `makeHandlers` call site to
`startAutomergeSyncNodeIfEnabled()`. T274 is the join-path equivalent.

## The load-bearing wrinkle — resolve and document this, it is NOT a pure mirror

Unlike bootstrap, the join flow runs its OWN temporary sync node:
`startJoinSession` (`joinSession.js`) calls `startSyncNode` to receive the camp
document during the join. So T274 must reconcile the temporary join node with the
persistent app-level node the starter manages. Resolve explicitly, first:
- Where does the join session's node lifecycle END (does `joinCancel`/session
  teardown stop it, does it persist, is it handed off)?
- Does invoking `startAutomergeSyncNodeIfEnabled()` after the camp materializes
  risk a DOUBLE node (the temporary join node still running alongside the
  persistent one), a port/listen clash, or a duplicated peer identity?
- Fire the hook at the correct point so exactly one persistent node runs after
  the join completes.
If resolving this requires stopping/nulling a node across a lifecycle boundary in
a way that resembles the held db-swap redesign, STOP and flag — do not expand
scope into that.

## Scope

- Add an injected `onCampJoined` hook (mirroring `onCampBootstrapped`), invoked
  where the joined camp materializes, wired at the initial `makeHandlers` site to
  `startAutomergeSyncNodeIfEnabled()`.
- Extend the wiring guard (`electron/mainSyncStartupWiring.test.js`) to pin the
  `onCampJoined` invariant analogously to `onCampBootstrapped`, and to keep the
  db-swap sites unwired for it too.

## Explicitly OUT of scope (do not touch)

- `electron/main.js` reinitialize (`makeHandlers` at ~:2677) and backup-restore
  (~:2917) db-swap sites. Those are a separate lifecycle redesign (the sync node
  is never stopped/nulled across a db swap) held for the owner. The wiring guard
  deliberately keeps them unwired; T274 must keep that guard GREEN, not wire them.

## Success predicate

- After a successful join-by-code, the device has a running persistent Automerge
  sync node for the rest of the session, no restart.
- Exactly one persistent node runs (no double-node with the temporary join node).
- The db-swap sites are untouched; `mainSyncStartupWiring.test.js` is green,
  including a new pinned invariant for `onCampJoined`.

## Does NOT count as done

- Wiring the db-swap sites.
- A unit test that mocks the starter without driving the real join path.
- Any change that leaves two sync nodes running after a join.

## Evidence required

- A behavioural test that drives the real join path (as T273's test drives the
  real bootstrapCamp path) and asserts the persistent starter runs after the camp
  materializes, exactly once.
- Non-vacuity: the test fails if the `onCampJoined` wiring is removed.
- Security + Red Hat review (join/auth path). `node scripts/check-governance.js`
  clean.
