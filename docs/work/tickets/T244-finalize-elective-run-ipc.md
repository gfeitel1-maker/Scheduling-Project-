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
> `FINALIZED_AGAINST_STALE_GENERATION` detection and its rendering to the director. If the detection
> does not ship inside T244 alongside finalize, and T250 does not render it, **the immutability
> ruling does not hold and the question returns to the owner.** Neither piece may be deferred out of
> these two tickets to unblock a release.
>
> **Surface corrected 2026-09-24 (owner) — condition unchanged, only the surface.** The ADR
> originally named "the existing per-slot findings vocabulary" as the render target. That vocabulary
> is schedule-week-scoped (single mount at `src/screens/ScheduleScreen.jsx:1142`, Locate gated on
> `row.groupId != null`) and cannot express run-level state. T250 renders this **inline in the run's
> own displayed run-state area on the elective run's screen**, not as a schedule finding and not as
> a banner. Nothing changes for this ticket's own work: T244 still computes and returns
> `finalizedAgainstStaleGeneration` alongside finalize. See the ADR's "Amendment (2026-09-24)".

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
  together. **This detection is not fully discharged by this ticket alone — T250 is required to render
  it on the Final-state screen, inline in the run's own run-state area rather than via the schedule
  findings vocabulary (see the ruling note above)** (see T250); this ticket's job is only to compute
  and return it.
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

## Implementation notes (added post-build — record of two shape deviations from the text above)

**`overCapacityOccurrences` is keyed by `(occurrenceId, activityId)`, not `occurrenceId` alone —
adds `activityId` to the declared shape.** `elective_occurrences` has no capacity column at all;
capacity is stored per `(elective_set_id, activity_id)` on `elective_set_activities`
(`capacity_mode`/`capacity_limit`, `capacity_mode` is the authority — `'unlimited'` is never
checked, `'limited'` with a NULL `capacity_limit` is skipped rather than fabricated). A bare
`{occurrenceId, capacity, filled}` tuple as literally written above is not attributable to
anything a director can act on without also knowing which activity is over capacity at that
occurrence. The shipped shape is `{occurrenceId, activityId, capacity, filled}` — a superset of
the ticket's declared fields, not a narrower one. Grouping is by `(a.occurrence_id, a.activity_id)`
over the same generation-visible rows the ticket specifies.
**Round 2 correction (Red Hat, verified against the code rather than
assumed):** despite the schema comment's `INVALID_CAPACITY` name, no finding
of that kind is emitted ANYWHERE in this codebase today —
`buildElectiveAssignments.js` only ever emits `NO_OFFERINGS`/`NO_CAMPERS`/
`NO_CAPACITY`. A `('limited', NULL)` offering is currently surfaced nowhere,
not here and not at generation time. The original note above (now struck)
claimed generation-time coverage that does not exist; `electron/main.js`'s
comment was corrected in the same round.

## Round 2 (Red Hat HIGH, confirmed and accepted)

**The gap: `FINALIZED_AGAINST_STALE_GENERATION`/`staleCount` were correct but INERT against real
data.** Nothing in shipped code ever wrote a non-null `solver_generation` — `commitElectiveRun.js`
never set it on the run or on the assignment rows it writes, so the round-1 detection could only
ever be exercised by a test that hand-forged the precondition with a direct `appendOp`, bypassing
every real handler. The owner's binding condition was therefore satisfied only on paper.

**Fix, in `electron/ops/commitElectiveRun.js` (the load-bearing change, not merely a stamping
detail):**
- One `randomUUID()` generation marker is minted per `commitElectiveRun` call and written to BOTH
  `elective_assignment_runs.solver_generation` (the run row) and `solver_generation` on every
  `elective_assignments` row that call writes, in the same transaction. Both halves together is
  load-bearing: the shared predicate is `source='manual' OR solver_generation IS <run's current>`,
  so stamping the run alone while leaving its own just-written rows at their old value would
  instantly hide them.
- Regeneration is `commitElectiveRun` called again with the same `providedRunId` (T199's flow).
  Each call mints its own fresh marker; rows the new call does not re-write keep their old marker
  and become stale under the predicate with **no separate re-stamp step** — this is exactly D5's
  design, and the ADR's decision (b)/Red Hat H3 correction deliberately deleted the re-stamp
  mechanism the original draft had. **T245/T246 must not re-add one.**
- Backward compatibility: a run written before this fix has NULL on both the run row and its
  assignment rows. `IS` (not `=`) makes NULL match NULL, so those pre-existing rows stay fully
  visible — pinned by a dedicated test
  (`electron/ops/commitElectiveRun.test.js`, "back-compat: a pre-existing run with NULL
  solver_generation on both halves still matches under IS").
- **A second, necessary fix surfaced by making the first one real:** `commitElectiveRun` used to
  write `status: 'draft'` unconditionally on every call, including a regeneration against an
  existing run. That is the H2 hazard in miniature — Device A finalizes locally (`status='final'`);
  Device B, whose local copy never saw A's write, legitimately regenerates its own still-draft
  copy; once merged, B's `status='draft'` op is an ordinary per-field LWW write, and if it carries a
  later timestamp than A's finalize it silently reverts `status` to `'draft'` campwide, with no
  error and no trace. Fixed: `status` is now asserted only on a run's first commit (no existing
  row); a regeneration of an existing run never touches it, so an already-`'final'` run stays
  `'final'` through a late-arriving regeneration, and `FINALIZED_AGAINST_STALE_GENERATION` — not a
  silently reverted status — is what surfaces the race to a director. Pinned by
  `commitElectiveRun.test.js`'s "does not touch status on a regeneration of an existing run" and
  "a genuinely NEW run ... still gets status=draft on its first commit".

**The end-to-end proof (discharges the owner's condition for real):**
`electron/electiveRunFinalize.integration.test.js`'s "case 8 (end-to-end, no hand-forged
solver_generation)" commits a run through `commitElectiveRunHandler`, finalizes it through
`finalizeElectiveRunHandler`, regenerates by calling `commitElectiveRunHandler` again with the same
`runId`, and reads through `getElectiveRunHandler` — asserting `finalizedAgainstStaleGeneration`
flips to `true`, the superseded generation's solver row is excluded from `rows` and counted in
`staleCount`, and a `source='manual'` row survives the regeneration. No step in this test writes
`solver_generation` via a hand-forged `appendOp`; the manual row's own `solver_generation` is left
untouched (NULL) rather than stamped, matching what a real manual placement looks like today (T245
does not exist yet).

Also added: a case where one run's `elective_run_outer_snapshots` rows carry MIXED generation
values (hand-forged deliberately — a single finalize call always stamps every snapshot row with
the same value, so this shape cannot occur through production writes; it exists purely to exercise
`getElectiveRunHandler`'s `.some(...)` comparison against more than a one-element array).

**`getElectiveRunHandler` returns an object, not a bare array — this was already implied by the
scope text (`rows` alongside `staleCount`/`finalizedAgainstStaleGeneration`/
`overCapacityOccurrences`) but is called out explicitly here since it is a breaking shape change.**
Verified callers at the time of this change: `src/localClient.js` (passthrough) and
`src/localClient.mock.js` — no screen consumed the bare array yet, so this was safe, and both
callers were updated in the same change so browser-dev does not build against a stale mock shape.
T248/T250 must read `result.rows`, not treat the return value itself as the row array.

**`electron/ops/projections.js`'s `elective_run_outer_snapshots.ensureExists` was fixed as part of
this ticket, not left as T243 shipped it.** T243's version only checked `field === 'run_id'` and
inserted `(id, run_id)`, but `camper_id`/`day_id`/`time_block_id` are NOT NULL with no default
(schema.sql) — that insert would violate those constraints the instant the `run_id` op applied,
before any of the other three fields arrived, so the write path this ticket exists to build could
never have materialized a row. Fixed with the same `readField`/`knownRow` wait-for-every-NOT-NULL-
column pattern `event_slots`/`schedule_snapshots` already use elsewhere in the same file.

## Dependencies

T243 (schema). Independent of T245/T247 (parallel). **Shares two files with T245, T248, and T249**
(`electron/main.js`, `electron/preload.js`) — see those tickets' notes: this is an ordinary git
merge-conflict risk from four tickets touching the same two files, not a logic dependency between
them. Convention: each ticket appends its handler(s) to the existing elective block in both files
in the order T244 → T245 → T248 → T249 merges, rather than reordering existing entries, to keep
conflicts mechanical.
