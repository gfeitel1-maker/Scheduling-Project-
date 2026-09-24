---
title: T244-finalize-elective-run-ipc
document_type: ticket
status: open
created: 2026-09-23
archive_when: shoresh:finalize-elective-run is callable, validates STALE_OUTER_SCHEDULE and OUTER_RESOURCE_CONFLICT before flipping status, writes the outer snapshot (including solver_generation) atomically, the shared generation-visibility predicate is extracted and used by getElectiveRunHandler, FINALIZED_AGAINST_STALE_GENERATION is detected and surfaced, and getElectiveRunHandler additionally returns overCapacityOccurrences (post-merge over-capacity detection, residual of Red Hat H3)
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, SECURITY.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md, docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md]
---

# T244 — finalize-elective-run IPC + SUPERSEDED_GENERATION read-side enforcement

Implements ADR 2026-09-23 decision (a) in full: the `shoresh:finalize-elective-run` handler,
`electron/preload.js` exposure, and the `getElectiveRunHandler` query change that actually excludes
stale-generation rows (D5 — currently prose-only).


> **Owner ruling, 2026-09-23 — binding condition.** Q1/Q2 (a finalized run is immutable; a revision
> is a new run, there is no reopen) was accepted **as a package** with the
> `FINALIZED_AGAINST_STALE_GENERATION` detection and its rendering as a finding. If the detection
> does not ship inside T244 alongside finalize, and T250 does not render it, **the immutability
> ruling does not hold and the question returns to the owner.** Neither piece may be deferred out of
> these two tickets to unblock a release.

## Scope

- `electron/main.js`: `finalizeElectiveRunHandler({token, runId})` per the ADR's exact response
  shape (`{ok:true,...}` / `{ok:false,error:'ALREADY_FINAL'}` / `STALE_OUTER_SCHEDULE` /
  `OUTER_RESOURCE_CONFLICT` / generic `{ok:false,error}`). Steps: authorize
  (`elective_assignment_runs.write`) -> load run -> already-final short-circuit -> re-derive
  occurrences and diff -> `routeConflicts` -> single transaction writing snapshot rows (each
  stamped with the run's current `solver_generation`, per the ADR's H2 fix) +
  `status`/`finalized_at`/`finalized_by`.
- `electron/preload.js`: `finalizeElectiveRun: (args) => ipcRenderer.invoke('shoresh:finalize-elective-run', args)`.
- **Extract the generation-visibility predicate into one shared module**
  (`electron/ops/electiveGenerationPredicate.js` or equivalent) exporting the WHERE-clause fragment
  the ADR names: `source = 'manual' OR solver_generation = (run's current solver_generation)`. This
  is a hard requirement, not a style preference — T248's `get-elective-run-outer-schedule` handler
  must import the same fragment, and the ADR calls out (MEDIUM-4) that specifying this predicate
  once per handler is exactly how "UI looks right, printed roster is wrong" happens. Do not inline
  the SQL twice.
- `getElectiveRunHandler`'s SQL: use the shared predicate above, plus a sibling `staleCount`
  computed from its inverse restricted to `source='solver'` rows, returned alongside the rows so a
  caller can render "N stale placements — regenerate."
- **`FINALIZED_AGAINST_STALE_GENERATION` detection**: `getElectiveRunHandler` (and any other reader
  of a final run's status) computes and returns `finalizedAgainstStaleGeneration: boolean` — true
  when `run.status==='final'` and the run's current `solver_generation` no longer matches the
  generation recorded on its `elective_run_outer_snapshots` rows. This is the ADR's H2 fix and is
  in scope for **this** ticket, not deferred — finalize and its own correctness detector ship
  together. **This finding is not fully discharged by this ticket alone — T250 is required to render
  it on the Final-state screen** (see T250); this ticket's job is only to compute and return it.
- **`overCapacityOccurrences` post-merge detection (residual of Red Hat H3 — the ADR's original
  "resolves as an ordinary capacity conflict" claim was wrong; see the ADR's corrected text under
  decision (b)).** `getElectiveRunHandler`'s query additionally groups generation-visible rows (per
  the shared predicate) by `occurrence_id`, compares the count to that occurrence's stored capacity,
  and returns any occurrence where visible placements exceed capacity as
  `overCapacityOccurrences: [{occurrenceId, capacity, filled}]` — same shape class as `staleCount`,
  computed the same way. This detects (does not prevent) the race where two devices independently
  place different unlocked campers into a seat a third device's not-yet-synced lock also wants,
  which the per-field `conflicts` machinery cannot see because the two placements are two different
  derived rows, not one contested row.
- Reuse `src/engine/routeConflicts.js` unmodified — call it, do not fork it.

## Non-goals

Any reopen/un-finalize path (ADR Open Question Q1 — explicitly not built pending owner ruling). Any
repair action for a run flagged `finalizedAgainstStaleGeneration` — per the ADR, the remediation is
an ordinary new run, not a special path. Draft editing (T245/T246). UI (T250).

## Test seam

Touches `electron/ops/**` (write path through the same transaction discipline as
`commitElectiveRun`) — **mandatory integration harness**. Specific cases to pin: (1) finalize on a
clean draft succeeds and snapshot row count matches assigned-camper × occupied-cell count, with
`solver_generation` stamped on every snapshot row; (2) a template edit after generation but before
finalize produces `STALE_OUTER_SCHEDULE` with a non-empty diff; (3) an `OUTER_RESOURCE_CONFLICT`
case built from a fixture with two overlays over capacity at one location/day/block; (4) calling
finalize twice returns `ALREADY_FINAL` the second time and writes no duplicate snapshot rows; (5)
`SUPERSEDED_GENERATION`-class rows are excluded from `getElectiveRunHandler`'s result set after a
regeneration that changed the marker, **except** rows with `source='manual'`, which must remain
visible regardless of marker (the H3 exemption — this is the specific case Red Hat's finding
requires a test for, do not skip it); (6) the H2 race itself, simulated directly rather than only
asserted about: finalize a run, then mutate `elective_assignment_runs.solver_generation` to a new
value (standing in for a since-synced concurrent regeneration merging in) without touching the
snapshot, and assert `finalizedAgainstStaleGeneration` reads `true`; (7) the H3 over-capacity race,
simulated directly: write two visible `elective_assignments` rows for two different campers against
the same `occurrence_id` such that their combined count exceeds that occurrence's stored capacity
(standing in for two devices' independent unlocked placements merging), and assert
`overCapacityOccurrences` includes that occurrence with the correct `capacity`/`filled` counts.

## Dependencies

T243 (schema). Independent of T245/T247 (parallel). **Shares two files with T245, T248, and T249**
(`electron/main.js`, `electron/preload.js`) — see those tickets' notes: this is an ordinary git
merge-conflict risk from four tickets touching the same two files, not a logic dependency between
them. Convention: each ticket appends its handler(s) to the existing elective block in both files
in the order T244 → T245 → T248 → T249 merges, rather than reordering existing entries, to keep
conflicts mechanical.
