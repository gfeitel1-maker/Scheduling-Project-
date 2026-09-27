---
title: "Extract startAutomergeSyncNodeIfEnabled so its behaviour is executed under test"
document_type: ticket
status: open
task_class: test-infrastructure
date: 2026-09-26
created: 2026-09-26
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_tickets: [docs/work/tickets/T274-join-by-code-sync-start.md]
program: relay-sync
archive_when: "startAutomergeSyncNodeIfEnabled (and its whenReady/onCampBootstrapped/onCampJoined wiring) is reachable and executed under Vitest, a real concurrent-execution test proves the in-flight latch admits at most one node start, and the AST-shape guards in mainSyncStartupWiring.test.js are replaced or backed by executed-behaviour tests"
---

# T276 — make the sync starter executed under test (discharge the AST-shape limitation)

## Priority: elevated — this is the executed-behaviour foundation for THREE tickets

`startAutomergeSyncNodeIfEnabled` and its `app.whenReady()` / `onCampBootstrapped` /
`onCampJoined` wiring are declared inside `electron/main.js`'s
`!process.env.VITEST`-gated `isElectronEntryPoint()` block, so **nothing in CI ever
executes them.** Three sync-startup tickets currently rest entirely on AST-shape
source assertions (that the seam fires with correct state, and that a real function
is on the other end), not on executed behaviour:

- **T273** (merged) — shipped with this as a stated known limit.
- **T274** — inherits it (the TOCTOU latch is proven correct by direct read, but its
  regression guard is AST-shape: it checks the latch is set before the first
  `AwaitExpression` and cleared in a `finally`, which a future conditional wrapper
  would still satisfy while breaking the behaviour).
- **T275** — will inherit it too.

T276 converts all three from source-shape assertions to executed behaviour by
extracting the starter (and enough of its wiring) so it can run under Vitest.

## Scope

- Extract `startAutomergeSyncNodeIfEnabled` (and the minimum surrounding wiring) out
  of the `!VITEST`-gated block so it is importable and executable under test.
- Add a real concurrent-execution test proving the in-flight latch
  (`automergeSyncNodeStarting`) admits at most one node start under two overlapping
  invocations — replacing the AST-shape guard for that property.
- Prefer replacing the AST-shape guards in `mainSyncStartupWiring.test.js` with (or
  backing them by) executed-behaviour tests where extraction makes it possible.

## Explicitly out of scope

- The db-swap lifecycle redesign (main.js reinitialize/restore node stop/null) — that
  remains a separate owner-held item.
- Any behaviour change to the starter itself; this is a testability extraction, not a
  logic change.

## Why it is not merely test-strength

An AST-shape guard passes on source structure; it cannot catch a regression that
keeps the shape (statement present, in a `finally`) while breaking the behaviour
(wrapping either latch statement in a conditional). Until the function is executed
under test, "the seam fires with correct state" and "the real starter is on the
other end" are asserted about source text, not observed. Sequence: **T274 →
T276 (before T275) → T275.**
