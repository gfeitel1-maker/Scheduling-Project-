---
title: "Individual elective scheduling — run lifecycle, draft editing, linked-choice network shape, and child-schedule export"
document_type: adr
status: accepted
authority: normative
implementation_state: not-started
date: 2026-09-23
approved: 2026-09-23 (owner, rulings on all six open questions recorded under "Owner rulings")
task_class: database-sync
governing_docs:
  - docs/governance/constitution/CONSTITUTION.md
  - docs/governance/standards/ARCHITECTURE_STANDARD.md
  - docs/governance/standards/WORK_RECORD_STANDARD.md
  - docs/governance/standards/TESTING_STANDARD.md
  - SECURITY.md
related_adrs:
  - docs/adr/2026-09-17-individual-elective-scheduling.md
related_specs:
  - docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md
related_tickets:
  - docs/work/tickets/T199-individual-electives-end-to-end.md
  - docs/work/tickets/T196-assignment-engine.md
  - docs/work/tickets/T197-projection-and-export.md
  - docs/work/tickets/T218-elective-export-third-party-adapter.md
  - docs/work/tickets/T219-multi-day-catalog-linkage.md
  - docs/work/tickets/T243-elective-run-lifecycle-schema.md
  - docs/work/tickets/T244-finalize-elective-run-ipc.md
  - docs/work/tickets/T245-draft-assignment-move-lock-ipc.md
  - docs/work/tickets/T246-engine-locked-seat-constraints.md
  - docs/work/tickets/T247-linked-choice-flow-network.md
  - docs/work/tickets/T248-child-schedule-export.md
  - docs/work/tickets/T249-encryption-gate-entry-point.md
  - docs/work/tickets/T250-draft-and-final-director-ui.md
  - docs/work/tickets/T251-t199-acceptance-fixture.md
---

# Elective run lifecycle, draft editing, linked-choice network shape, and child-schedule export

**Status: accepted (owner, 2026-09-23). This was the owner gate and it is satisfied.** The
technical decisions (a)-(e) are accepted, and all six product questions are ruled on — see
**"Owner rulings"** immediately below "Open questions", which is where the rulings live; the
question text is kept unedited beneath it so a later reader can see what was actually asked.
**Slices T243-T251 are authorized.**

**One ruling is conditional and the condition is binding, not advisory.** Q1/Q2 (immutable runs, no
reopen) was accepted *as a package* with the `FINALIZED_AGAINST_STALE_GENERATION` detection and its
rendering. If that detection does not ship inside T244 alongside finalize, and T250 does not render
it as a finding, **the immutability ruling does not hold and this returns to the owner.** It is not
a follow-up, and it may not be deferred out of those two tickets to unblock a release.


**This is a follow-on to `docs/adr/2026-09-17-individual-elective-scheduling.md`, not a
supersession.** That ADR (D1-D14) decided the data substrate, the derived-id discipline, the
admin-only participant domain, the purge path, and — critically — withdrew the ranked-per-occurrence
preference premise (D14) without replacing it. This ADR picks up exactly where that one stopped:
the run lifecycle T199 describes in its director-flow table (Draft, Final) but that no code
implements yet, plus the three things D14's withdrawal left structurally open (D6's finalization
snapshot, D5's `solver_generation` enforcement, D12's linked-choice network shape).

Ground truth this ADR designs against (verified against the tree on 2026-09-23, not carried
forward from memory):

- `elective_assignment_runs.status` is `CHECK (status IN ('draft', 'final'))` but nothing writes
  `'final'` — no `finalized_at`, no `finalized_by`, no outer-schedule snapshot table exist.
- `solver_generation` is stored on both `elective_assignment_runs` and `elective_assignments` but
  never read — D5's "inert assignment" rule is prose only.
- `is_locked` and `source` exist on `elective_assignments` and are never written outside
  `commitElectiveRun`'s solver path (`source` defaults `'solver'`).
- `src/engine/buildElectiveAssignments.js` solves per-occurrence, sequentially by ascending
  occurrence id, and never reads `is_linked` — D12's atomic-expansion promise is unimplemented.
- `electron/preload.js`/`electron/main.js` expose exactly three elective channels:
  `commitElectiveRun`, `listElectiveRuns`, `getElectiveRun`. No finalize, no move/lock, no
  regenerate-with-locked-seats, no per-camper export.
- `src/engine/routeConflicts.js` (T193/D7) exists, is pure, and reports
  `OUTER_RESOURCE_CONFLICT` from concrete location/day/block occupancy — it is callable from a
  finalize path but is currently wired only into `buildSchedule.js:879`.
- No per-camper/child schedule export exists anywhere (`src/utils/exportSchedule.js` is
  group×day×block only, and is not span-aware — the same defect D12 flagged for the group export
  applies here).
- `SHORESH_AT_REST_ENCRYPTION` is read only in `electron/`; nothing in `src/` surfaces its state,
  so D8's release gate has no UI-visible statement anywhere.

## Candidate approaches considered (per decision)

Divergence was run per sub-decision rather than once for the whole ADR — the five questions (a-e)
are only loosely coupled and a single wide brainstorm would have blurred which idea answers which
question. For each, the genuinely different candidates and why the loser was rejected:

**Lifecycle contract (a).** (1) *Finalize as a status flip only* — cheapest, but leaves D6's "final
run reads a snapshot" unimplemented, so a finalized run silently changes when the template is
edited later; rejected, it doesn't satisfy the ADR it's built on. (2) *Finalize as a new
denormalized `elective_run_snapshots` table, one row per run, holding the whole export payload
pre-rendered* — maximal, but duplicates the child-schedule export's own shape and would need its
own staleness story; rejected as premature (nothing yet defines what the export payload looks like
— see (d)). (3) ★ *Finalize as a status flip plus a narrow outer-cell snapshot table keyed by
(run_id, camper_id, day_id, time_block_id), validated against re-derived occurrences and
`routeConflicts` before the flip* — matches D6's own wording exactly and reuses D7's existing pure
validator instead of inventing a second one. Chosen.

**Draft editing / locking (b).** (1) *A new `elective_assignment_overrides` table, merged with
solver output at read time* — keeps solver output untouched, but reintroduces exactly the
two-rows-for-one-fact problem D4 built the derived-id scheme to eliminate; rejected. (2) ★ *Write
straight to the same derived `elective_assignments` row the solver writes, flip `source`/
`is_locked`* — one row, one identity, the existing per-field conflict machinery already handles
concurrent writers; the regeneration step must skip locked rows rather than overwrite them. Chosen,
because it costs nothing new at the storage layer — only a read-path rule in the engine.

**Linked-choice network (c) — redone 2026-09-23 after Red Hat found the first pass wrong.** The
original candidate (2) below — "a single chain per choice" — was **incorrect**, not merely
suboptimal, and was caught only by working a concrete example, not by inspection. That example is
reproduced here because the correction depends on it.

*Why (2) fails.* A chain `camper → choiceNode(C) → o1 → o2 → sink` with every edge capacity 1
instantiates **one chain per choice**, not one per camper. Take choice `C = {o1, o2}`, both with
capacity 15, and two campers, Alice and Bob, who both rank `C`. The `o1 → o2` edge inside the chain
has capacity 1 by construction. Alice's flow unit saturates it; Bob's augmenting search finds no
residual path through `o1 → o2` and Bob is reported `NO_CAPACITY`, with 14 seats sitting open at
each occurrence. The construction caps every linked choice at one camper **camp-wide**, regardless
of real capacity — it does not implement atomic expansion, it implements a capacity-1 ceiling that
looks like atomic expansion until a second camper is tried against it. The ADR's accompanying claim
that this "does not touch `minCostAssign`" was also false: `minCostAssign`
(`src/engine/buildElectiveAssignments.js:178-224`) solves a row×column bipartite matching over a
flat `capacity[]` vector, one scalar per column — it has no notion of an edge *between* two
columns, so any chain or multi-hop topology is not an extension of that function, it is a
replacement of it with a general graph solver.

Candidates, re-evaluated honestly against that constraint:

(1) *General graph min-cost flow, replacing `minCostAssign` outright* — the only construction that
can express "one flow unit reserves capacity at N columns simultaneously" with correct per-column
capacities in the presence of choices that overlap on a shared occurrence (two different linked
choices both including `o1`, say). Correct in the general case. Rejected **for this slice**: it is
a genuine rewrite of the solved, tested, five-week-old core of T196 — not a drop-in — and nothing
about the real data (D14/T218: no filled-in preference artifact and no confirmed third-party export
format have ever been seen) justifies that cost yet. Recorded as the right answer if overlapping
linked choices turn out to be real and common; not built now.

(2) *Chain-per-choice with capacity-1 edges* — **wrong**, per the worked example above. Rejected,
not merely deprioritized.

(3) ★ *Reuse `minCostAssign` unmodified, called a second time as a separate bipartite tier over
choices instead of occurrences* — rows = campers with any linked-choice (`n>1`) preference,
columns = linked choices, `capacity[choice] = min(capacity of every member occurrence)`. A placed
`(camper, choice)` pair expands to one `elective_assignments` row per member occurrence, and each
member occurrence's remaining capacity for the *existing* per-occurrence tier is reduced by that
placement — using the exact same "treat as pre-placed" mechanism (b)/T246 already introduces for
locked seats, not a new mechanism. Chosen, **with the precondition stated below** that this
candidate does not attempt to solve — a second linked choice sharing a member occurrence with the
first is out of scope for this construction and must be refused, not silently mis-solved, because
`capacity[C1] = min(...)` and `capacity[C2] = min(...)` are independent scalars that do not see
each other's consumption of the shared occurrence.

(4) *Solve linked choices as a separate integer-program pass, subtract consumed capacity, then flow
the rest* — this is candidate (3) with a different (and unjustified, given (3) already reuses the
existing exact solver) tool. Still rejected under `karpathy-guidelines`, now for the corrected
reason that (3) achieves the same result with the tool already in the codebase, not because a chain
topology already solved it — it didn't.

**Re-assessment note.** The original ADR's rejection of "a separate pass before flow" was written
to compare against the wrong chosen candidate (the broken chain). Against the corrected chosen
candidate (3), that rejection still holds, but for the reason above, not the one originally given.

**Child-schedule export (d).** (1) *A new admin-scoped IPC handler that renders the export
server-side* — consistent with how `exportElectiveRun.js` reads data the renderer already loaded,
this repo's existing pattern is renderer-side rendering, not a server-rendered export; a new
IPC handler here would be the first of its kind and adds an attack surface D9 explicitly chose not
to build. Rejected as inconsistent with the established seam. (2) ★ *A renderer-side utility,
`src/screens/elective/export/exportChildSchedule.js`, reading a new read-only, admin-gated IPC
(`shoresh:get-elective-run-outer-schedule`) for the non-elective cells the run's campers occupy —
live-derived for a draft, read from the (a) snapshot for a final run* — mirrors the existing
`exportElectiveRun.js`/`exportSchedule.js` pattern exactly, adds exactly one new IPC read (a
symmetric sibling of `getElectiveRun`), and inherits D9's implicit staff-exclusion for free
because the new channel is gated the same way. Chosen.

**Encryption gate (e).** (1) *A dismissible banner* — forbidden outright by this repo's standing
"no banners" rule; not seriously considered. (2) ★ *A persistent, non-dismissible disclosure line
in the feature's own entry screen (the "No run" state), sourced from a new read-only IPC exposing
`SHORESH_AT_REST_ENCRYPTION`'s resolved state* — visible every time the screen is reached, cannot
be dismissed into invisibility, and is a single boolean read, not new policy. Chosen.

## Decision

### a. Run lifecycle contract: draft → final

**New IPC channel: `shoresh:finalize-elective-run`.**

```
finalizeElectiveRun({ token, runId }) -> Promise<
    { ok: true, finalizedAt: string, snapshotRows: number }
  | { ok: false, error: 'STALE_OUTER_SCHEDULE', findings: [...] }
  | { ok: false, error: 'OUTER_RESOURCE_CONFLICT', findings: [...] }
  | { ok: false, error: 'ALREADY_FINAL' }         // idempotent no-op signal, not a throw
  | { ok: false, error: string }                   // e.g. 'run not found', 'run has no assignments'
>
```

Handler contract (mirrors `commitElectiveRunHandler`'s established shape — throw for programmer
errors, return `{ok:false, error}` for director-facing refusals):

1. `requireAuthorized(db, {token, action: 'elective_assignment_runs.write'})` — same action name
   already used by `commitElectiveRun`, no new permission entry needed (D9's admin-only grant
   already covers writes to this entity).
2. Load the run. If `status === 'final'` already, return `{ok:false, error:'ALREADY_FINAL'}` —
   **not** an error the caller should retry differently; this is the idempotency answer (see
   "Interface-contract checklist" below).
3. Re-derive occurrences from live `template_slots` (the same derivation `commitElectiveRun`'s
   generation path already performs) and diff against the run's recorded occurrence set. A
   mismatch is `STALE_OUTER_SCHEDULE` — return the diff as `findings` so the UI can offer
   "re-derive and regenerate" per T199's flow table, never just a block.
4. Run `routeConflicts` (T193/D7, already merged and pure) over the live schedule state scoped to
   this run's occurrences. Any conflict is `OUTER_RESOURCE_CONFLICT` — return the reported cells.
5. On success, in one transaction: write one row per (camper, day, time_block) the run's assigned
   campers occupy into the new `elective_run_outer_snapshots` table (see schema below), set
   `status='final'`, `finalized_at=now()`, `finalized_by=session.userId`.

**Idempotency / concurrent retries.** A dropped connection after step 5 committed but before the
renderer sees the response is answered the same way `ALREADY_FINAL` answers a deliberate
double-click: the caller's retry re-reads the run, sees `status==='final'`, and gets
`{ok:false, error:'ALREADY_FINAL'}` — which the UI treats as success-already-happened, not failure.
This requires **no client_write_id** because the transition is naturally idempotent by re-checking
committed state, the same discipline D4/D5 already use for the derived-id and generation-marker
schemes — no new retry primitive is introduced.

**Concurrent finalize from two devices — corrected 2026-09-23, Red Hat H2.** The original text here
claimed a divergence always surfaces as an ordinary `conflicts` row on a shared field. That is true
only for a **content** disagreement on a row both devices write. It is false for the race Red Hat
found, which is a **set-membership** disagreement the derived-id/LWW machinery cannot see at all:

Device A finalizes locally against generation `gen-1` and writes a snapshot enumerating `gen-1`'s
roster. Meanwhile Device B had already regenerated to `gen-2` — a legitimate, unrelated draft edit
— but that write has not yet synced to A. B never writes A's snapshot rows (B has moved past
`gen-1` and has no reason to touch them), so nothing contests them: no shared row, no per-field
conflict, no `conflicts` entry. Once the two devices' histories merge, `elective_run_outer_snapshots`
holds a byte-stable, exported, permanently "final" roster that is provably wrong — and, combined
with this ADR's own Q1/Q2 recommendation (immutable, no reopen), nothing in the design as first
written would ever surface that.

**This cannot be prevented** — A has no way to know about B's not-yet-synced write at the moment A
finalizes; that is the nature of eventual consistency in this app's whole architecture and is not
special to this feature. It can be **detected**, which is the fix:

1. `elective_run_outer_snapshots` records the `solver_generation` marker it was taken against (new
   column, added to the DDL below) — the snapshot now states which generation it is a photograph
   of, not just what it contains.
2. A new finding, computed wherever a run's status is read (the shared predicate in "Reused vs.
   new"/MEDIUM-4 below, not a one-off query): `FINALIZED_AGAINST_STALE_GENERATION`, raised whenever
   `run.status === 'final'` and the run's *current* `solver_generation` (which can move after
   finalize, if a since-synced device's earlier regeneration merges in later) no longer matches the
   generation the snapshot recorded. This is a **post-hoc detection finding**, the same vocabulary
   class as `SUPERSEDED_GENERATION` and `STALE_OUTER_SCHEDULE` — surfaced, never silent.
3. Remediation, given the immutable/no-reopen default: a director who sees this finding starts a
   new run, exactly as an ordinary revision (Q1/Q2, revised below). No special repair path is
   designed — this matches how the rest of this design already treats cross-device races (detect
   and report, let the director act), and building a repair-in-place path would reopen the same
   state-machine questions Q1/Q2 already declined to take on.

**Where this reaches a human (residual of Red Hat H2 — a detection nobody renders is functionally
no detection).** `finalizedAgainstStaleGeneration` must not stop at being a computable boolean in an
IPC response. **T250's Final-state screen is in scope to render it**, as a finding using this repo's
existing per-slot findings vocabulary — never a banner — with copy along the lines of "This run was
finalized before a later change on another device synced in; it is out of date" plus the "start a
revision" action already on that screen (which is exactly what step 3 above says the director should
do). T248's export payload also carries the flag (unchanged from the original draft) so a file
already handed to staff is traceably suspect, but the export is not where a director makes the
decision to revise — the export happens *after* that decision, so it cannot be the only place this
surfaces. T250's scope and `archive_when` are revised accordingly (see T250).

This changes the Q1/Q2 recommendation: see the revised text under "Open questions" — immutability is
still recommended, but it is no longer recommended *without* this detection finding; the two are now
one package, not a lifecycle default plus an optional nicety.

**Revision.** Per the "Open questions" section, whether a finalized run is user-editable is a
product question. The technical design below assumes the *provisional, owner-reviewable* default:
**finalized runs are immutable — no reopen IPC exists.** A "revision" is a new
`elective_assignment_run` row (new `commitElectiveRun` call against the same week/route/division);
the prior final run is retained, unchanged, and remains listable/exportable. This costs nothing to
change later (adding a reopen channel is additive), and costs nothing now (no reopen state machine
to build, test, or secure). If the owner rules that directors need in-place correction of a final
run, that is a new IPC (`shoresh:reopen-elective-run`) added on top of this design, not a rewrite of
it.

**`SUPERSEDED_GENERATION` enforcement in the projection — and the one shared predicate every reader
must use (Red Hat MEDIUM-4).** Today nothing reads `solver_generation`. The rule is:

> **Generation-visibility predicate:** an `elective_assignments` row is visible when
> `source = 'manual' OR solver_generation = (run's current solver_generation)`.

The `source = 'manual'` exemption is new in this revision — see decision (b) below (Red Hat H3) for
why a manually-placed/locked row must **never** be excluded by a generation mismatch, only a
solver-produced row.

This predicate is named and extracted once — a shared SQL fragment (e.g.
`electron/ops/electiveGenerationPredicate.js` exporting the WHERE-clause text) — and **every**
handler that reads `elective_assignments` must use that same fragment, not re-derive it:
`getElectiveRunHandler` (T244), the new `get-elective-run-outer-schedule` handler (decision (d),
T248), and any future T198 machine-access adapter that reads assignments. This is a hard
requirement on T244 and T248 alike — the original draft of this ADR specified the filter only for
`getElectiveRunHandler`, which would have let the UI show a correct roster while an exported/printed
roster (built from the other handler) silently disagreed with it. `getElectiveRunHandler` also
returns a `staleCount` (a `COUNT(*)` over the inverse of the predicate, restricted to
`source='solver'` rows) so the UI can tell the director "N stale placements exist, regenerate," and
a `finalizedAgainstStaleGeneration: boolean` per the H2 fix above.

**Guarding the "every reader must use the shared fragment" requirement with a test, not just
prose (residual finding, MEDIUM-4).** T244's own six cases and T248's own seam each exercise one
handler in isolation — nothing today would catch a future reader that stops importing
`electiveGenerationPredicate.js` and re-derives its own filter, which is exactly the "UI right,
export wrong" failure this predicate exists to prevent. **T248 owns a named cross-handler fixture
test**: build one fixture with a regeneration that leaves a stale-generation solver row and a
`source='manual'` row behind, call both `getElectiveRunHandler` (T244) and
`getElectiveRunOuterSchedule`'s draft-derive path (T248) against it, and assert the two report
**identical roster membership** (same camper set, same manual-row inclusion, same stale-row
exclusion). T248's scope and `archive_when` are revised accordingly (see T248).

**Schema additions (v73):**

```sql
ALTER TABLE elective_assignment_runs ADD COLUMN finalized_at TEXT;
ALTER TABLE elective_assignment_runs ADD COLUMN finalized_by TEXT;

CREATE TABLE IF NOT EXISTS elective_run_outer_snapshots (
  id TEXT PRIMARY KEY,       -- deriveElectiveRunOuterSnapshotId(run_id, camper_id, day_id, time_block_id)
  run_id TEXT NOT NULL,
  camper_id TEXT NOT NULL,
  day_id TEXT,
  time_block_id TEXT,
  activity_id TEXT,
  activity_name TEXT,        -- denormalized: D6 requires the export to survive the activity being renamed/deleted later
  location_id TEXT,
  location_name TEXT,
  span_blocks INTEGER,
  solver_generation TEXT     -- added 2026-09-23 (Red Hat H2): the marker this snapshot was taken
                              -- against, so a later-merged regeneration from another device can be
                              -- detected (FINALIZED_AGAINST_STALE_GENERATION) rather than silently
                              -- exported as if it were still current
);
```

Denormalizing `activity_name`/`location_name` (rather than only ids) is deliberate and required by
D6's own text: "a finalized run remains exportable and byte-stable even if the template is later
edited or deleted." An id-only snapshot would not survive a deleted activity.

### b. Draft editing: move and lock

**New IPC channel: `shoresh:set-elective-assignment`.**

```
setElectiveAssignment({ token, runId, camperId, occurrenceId, activityId, locked }) -> Promise<
    { ok: true, assignmentId: string }
  | { ok: false, error: 'RUN_NOT_DRAFT' }
  | { ok: false, error: 'OCCURRENCE_FULL', capacity: number, filled: number }
  | { ok: false, error: 'CAMPER_INELIGIBLE' }
  | { ok: false, error: string }
>
```

Writes to the **same** derived row the solver writes:
`deriveElectiveAssignmentId(run_id, camper_id, occurrence_id)` (D4 — already implemented,
`electron/ops/electiveAssignmentId.js` or equivalent). Sets `activity_id`, `source='manual'`,
`is_locked = locked ? 1 : 0`. `solver_generation` is set to whatever the run's marker is *at the
moment of the write* and is then **never touched again by any other code path** — see the corrected
mechanism below, which replaces the original "re-stamp on every regeneration" design after Red Hat
found it broken.

Refuses (`RUN_NOT_DRAFT`) once `status==='final'` — consistent with (a)'s immutability default.
Capacity/eligibility checks reuse the same helpers `buildElectiveAssignments` already uses
internally (`resolveElectiveOfferingLocations`/eligibility resolution) so there is one definition
of "this camper may occupy this offering," not two.

**Surviving regeneration — corrected 2026-09-23, Red Hat H3.** The original design had
`commitElectiveRun`'s generation path re-stamp every `is_locked=1` row's `solver_generation` to the
new marker on each regeneration, "carrying it forward" so it wouldn't be excluded by the
generation-visibility predicate. That re-stamp reads locked rows from the **regenerating device's
own local database**. If Device A locks camper X and that write has not yet synced to Device B,
and B then regenerates — a perfectly ordinary, unrelated action — B's local query sees no lock on
X, does not re-stamp it, and writes the new `gen-2` marker onto the run as an ordinary scalar field.
Once merged, X's locked row still carries `gen-1` against a run now at `gen-2`. Under the *original*
predicate (bare generation equality) that row is excluded — the director's manual placement
disappears from every screen with no error, no conflict, no finding: precisely the silent-loss
outcome decision (b) exists to prevent. D5's premise ("a run has one generating device") stopped
holding the moment (b) added a second, independently-timed writer — the move/lock IPC — against the
same marker, and the original design didn't account for that.

**Fix: locked/manual rows are exempt from the generation-visibility predicate entirely (stated
above under decision (a)/MEDIUM-4) — `source = 'manual' OR solver_generation = current`.** This
removes the re-stamping step altogether: `commitElectiveRun`'s generation path still queries
`elective_assignments WHERE run_id = ? AND is_locked = 1` and passes those rows into
`buildElectiveAssignments` as `lockedAssignments` (unchanged — this is the capacity-reservation half
of "surviving regeneration," and is unaffected by this fix), but it no longer needs to touch their
`solver_generation` at all, on any device, ever. A locked row's visibility no longer depends on any
device having seen it before regenerating.

**The residual risk this does NOT remove — corrected 2026-09-23, residual of Red Hat H3.** Two
devices independently placing different *unlocked* campers into a seat a third device's
not-yet-synced lock also wants was originally described here as resolving "as an ordinary capacity
conflict once merged (a `NO_CAPACITY`-class finding or an ordinary per-field `conflicts` row)." That
sentence was **wrong** and is deleted: (a) `deriveElectiveAssignmentId` includes `camper_id`, so two
different campers placed into the same occurrence are two *different* rows with two different derived
ids — the per-field LWW/`conflicts` machinery only reconciles two writes to the *same* row, and has no
mechanism to see that two independently-valid rows jointly overbook one occurrence; (b)
`NO_CAPACITY` is a finding computed *during* a solve, and finalize's own checks
(`STALE_OUTER_SCHEDULE`/`OUTER_RESOURCE_CONFLICT` via `routeConflicts`) cover the *outer* schedule,
not elective-internal over-capacity. So today, as designed, an occurrence can end up silently
overbooked after a merge with no finding, no conflict row, and no UI signal anywhere in T243-T251.

**Fix: a real post-merge `OVER_CAPACITY`-class finding, computed across already-committed
`elective_assignments` rows, owned by T244.** Alongside `staleCount` and
`finalizedAgainstStaleGeneration`, `getElectiveRunHandler`'s query additionally groups the
generation-visible rows (per the shared predicate) by `occurrence_id` and compares the count against
that occurrence's stored capacity; any occurrence where visible placements exceed capacity is
returned as an `overCapacityOccurrences: [{occurrenceId, capacity, filled}]` array — the same shape
class as `staleCount`, computed the same way (a `COUNT(*) ... GROUP BY` over rows the read path
already loads), not a new query mechanism. This is a detection, not a prevention — it cannot stop
the race, only surface it the next time the run is read, which is the same posture D5/D6/H2 already
take everywhere else in this design. T244's scope and test list are revised accordingly (see T244).

**This exemption is a deliberate, bounded relaxation of D5, not merely a bug fix — say so plainly
(residual of Red Hat H3).** D5's rule was that a stale-generation row is inert everywhere, precisely
so the projection never mixes fact from two different solve runs. The `source='manual'` exemption
means the projection is now, permanently and by design, a mix of "current generation" (solver rows)
plus "whatever generation was current when this seat was manually locked, possibly several
regenerations ago" (manual rows) — a bounded, deliberate reintroduction of exactly the
cross-generation incoherence D5 existed to forbid, scoped to rows a human explicitly pinned. The
trade is right because the alternative (a lock that silently vanishes from every screen the moment
another device regenerates, per the H3 counter-example above) is strictly worse for a director than
a lock that is visible but was made against an older generation; the cost is that "this run's
generation" stops being a single coherent fact once any lock exists, which the run-level `staleCount`
already partially communicates (it counts stale *solver* rows) but does not (and by construction,
cannot) count manual rows against, since those are exempt by design, not by omission.

**Edge case: a manual row's `occurrence_id` outliving the occurrence itself (residual of Red Hat
H3).** A manual/locked row is exempt from the *generation* filter, which says nothing about whether
the occurrence it points at still exists after a template edit deletes or reshapes it — a dangling
`occurrence_id`. Today only finalize's `STALE_OUTER_SCHEDULE` diff (decision (a), T244) would ever
notice this, and only at finalize time, not during ordinary draft regeneration. **Fix: T246's
regeneration path checks locked rows' `occurrence_id` against the live-derived occurrence set it
already re-derives for its own solve, and reports any manual row whose occurrence no longer exists as
a new `DANGLING_MANUAL_ASSIGNMENT` finding** (the same vocabulary class as `UNSUPPORTED_LINKED_CHOICE`
and `NO_CAPACITY` — surfaced, not silently dropped or silently kept). This does not delete or
auto-repair the row; a director who sees the finding can unlock/reassign it via T245's existing
move/lock IPC. T246's scope is revised accordingly (see T246).

`buildElectiveAssignments`'s interface gains one new input:

```
buildElectiveAssignments({ campers, occurrences, offerings, preferences, attendance, lockedAssignments })
```

`lockedAssignments: [{camperId, occurrenceId, activityId}]`. Before building the flow network for
an occurrence, the engine subtracts each locked seat from that offering's remaining capacity and
removes that camper from the free-variable set for that occurrence — the solver never re-decides a
locked seat, it only fills what's left.

**Ownership of "a locked seat that is also a member of a linked choice" (Red Hat's smaller finding):
T246 owns this.** T246's `lockedAssignments` handling decides how a locked single-occurrence seat
interacts with a linked choice's chain expansion (decision (c)/T247); T247 consumes whatever
capacity-reservation contract T246 settles on and does not re-decide it.

### c. Linked choices: network shape — corrected 2026-09-23, Red Hat H1

See "Candidate approaches" (c) above for the full derivation. The corrected design is a **second,
separate bipartite tier**, reusing `minCostAssign` unmodified twice rather than modifying it once:

**Tier 1 — linked choices.** Rows = campers with a preference on any choice `C` where
`elective_choice_offerings` gives `C` more than one member; columns = those linked choices;
`capacity[C] = min(capacity of every member occurrence of C)`. Solved with the existing
`minCostAssign(cost, capacity)` — no change to that function. Each placed `(camper, C)` pair expands
to one `elective_assignments` row per member occurrence of `C`, sharing one `choice_id` and
`preference_rank`.

**Tier 2 — everything else.** The existing per-occurrence solve runs exactly as it does today, over
whatever capacity tier 1 left: each member occurrence's remaining capacity is reduced by the number
of tier-1 placements that consumed a seat there, and every camper tier 1 already placed is removed
from that occurrence's row set — using the **same** "pre-placed, capacity pre-consumed" mechanism
decision (b)/T246 already introduces for locked seats, not a second new mechanism.

**Worked example — proving tier 1 correct where the original chain construction was not.** Choice
`C = {o1, o2}`, `capacity(o1) = capacity(o2) = 15`. Alice and Bob both rank `C`.
`capacity[C] = min(15, 15) = 15`. `minCostAssign` over rows `[Alice, Bob]`, column `[C]`,
`capacity = [15]` places **both** — 15 is not exceeded by 2. Expansion writes: Alice→o1, Alice→o2,
Bob→o1, Bob→o2. Tier 2 then sees `o1` and `o2` each with `15 - 2 = 13` seats remaining for anyone
else's unlinked preferences. This is the same worked example Red Hat used to break the chain
construction (which capped this at one camper camp-wide); tier 1 places both correctly, bounded by
real capacity, because it is an ordinary bipartite match, not a serial chain.

**What this construction does NOT solve, stated rather than silently assumed away.** If a *second*
linked choice `C2` also includes `o1` as a member (two different chugim both offered in the same
AM block, say), tier 1 as described has no way to see that `C`'s and `C2`'s consumption of `o1`
must be jointly bounded by `o1`'s real capacity — `capacity[C]` and `capacity[C2]` are independent
scalars in two unrelated `minCostAssign` calls (or two rows of the same call; either way, nothing
couples them to `o1`'s single true capacity). Solving that correctly is candidate (1) from the
divergence above — a real graph rewrite of the solver — which this ADR declines to build now for
the reasons given there.

**Scope line, enforced as a precondition rather than silently mis-solved:** `UNSUPPORTED_LINKED_CHOICE`
(per D12) fires when a choice's members reference occurrences outside the run, reference an
occurrence the camper is structurally ineligible for, **or when two linked choices in the same run
share a member occurrence** (the new case this correction adds — an honest implementation
limitation, not a data-malformation, and labeled as such in the finding's message). It does not fire
on ordinary capacity infeasibility, which remains an unassigned-camper `NO_CAPACITY`-class finding
naming which member occurrence lacked room.

This remains the smallest shape that does not foreclose either open question from D14/T218
(camper-declared vs. catalog-declared linkage, or the real third-party import format) **for the
non-overlapping case**. Whether overlapping linked choices are common enough in real catalogs to
justify the tier-1 rewrite is itself a question only real data (T218/T219) can answer — this design
does not guess at it.

**What the two-tier split does NOT solve, stated rather than silently assumed away (residual of
Red Hat H1) — this drops D11's optimality guarantee, and this ADR must say so plainly.** The
2026-09-17 ADR's D11 chose min-cost max-flow specifically so that the assignment is "provably
optimal … under the stated cost function" — its own stated purpose was the safeguard against "the
computer could have given Sara her third choice and didn't." Two sequential, independently-solved
bipartite passes is structurally the priority-class greedy D11 rejected: tier 1 finalizes every
linked-choice placement before tier 2 ever looks at an unlinked preference, so no joint solve ever
compares the two against each other. Concrete failure case: a camper with a *low-ranked* linked-choice
preference and a *high-ranked* unlinked preference for a scarce, popular activity — tier 1 places
that camper into the linked choice (consuming their only "slot" in the sequential process before
tier 2 runs), and tier 2 then has no way to have preferred the camper's high-ranked unlinked choice
over their low-ranked linked one, because the two were never compared inside one cost function. A
single joint solve could have placed the camper in the scarce activity and left the linked choice's
seat for someone else; this construction cannot express that trade at all.

**Who can be affected, and how often.** Only campers who rank *both* a linked choice and an unlinked
preference for a scarce/contended activity are exposed — a camper who only ranks unlinked
preferences, or who ranks a linked choice but no contended unlinked activity, sees identical output
to a true joint solve. The size of the affected population is not something this design can bound
from first principles: it depends on how common linked choices are in a real catalog (T218/T219,
still unanswered) and on how much preference overlap real campers show between linked and unlinked
picks — data this ADR does not have. This is an honest gap in the bound, not a claim that the effect
is small.

**Accepted tradeoff, or owner question? This is an owner question — added below as Q6 — because
D11's optimality promise was itself owner-facing reasoning ("no camper systematically gets worse
service because of solve order"), and silently trading that promise away inside an ADR that D11
lives in is exactly the kind of undisclosed regression this design's own "detect and surface, never
silently succeed" posture (D5/D6/D10, H2, H3) exists to prevent.**

**Answering Red Hat's closing question directly: tier 1 is provably correct on the 2-camper worked
example above (an ordinary bipartite match under `minCostAssign`'s existing, tested semantics). It
does not escalate to the owner for that case.** It does escalate — as a recorded, explicit
limitation, not a silent gap — for the overlapping-choice case, and separately (Q6) for the
cross-tier optimality loss, both deferred rather than guessed at.

### d. Per-camper (child) schedule export

**New IPC channel: `shoresh:get-elective-run-outer-schedule`** (read-only, `elective_assignment_runs.read`
— the same action `getElectiveRun` already requires, no new permission entry):

```
getElectiveRunOuterSchedule({ token, runId }) -> Array<{
  camperId, dayId, timeBlockId, activityId, activityName, locationId, locationName, spanBlocks
}>
```

For a `final` run, this is a straight `SELECT * FROM elective_run_outer_snapshots WHERE run_id = ?`
— reading (a)'s snapshot, per D6. For a `draft` run, the handler derives it live: for each assigned
camper's group, look up that group's `template_slots` for the run's week/route (excluding elective
cells, which the export already has from `elective_assignments`) and resolve span membership via
the existing `collectSpanTails`/`getActivityRowSpan` helpers (`useSlotMutations.js`,
`gridGeometry.js`) — this is the span-awareness D12 flagged as missing from the group export, fixed
here rather than inherited, and returned in `spanBlocks` so the renderer prints a 3-block swim once,
not three times.

**Renderer-side export**, `src/screens/elective/export/exportChildSchedule.js`, mirrors
`exportElectiveRun.js`'s shape:

```json
{
  "format_version": 1,
  "run_id": "...",
  "run_name": "...",
  "run_status": "draft" | "final",
  "generated_at": "...",
  "campers": [
    { "camper_id": "...", "display_name": "...", "group_name": "...",
      "schedule": [
        { "day": "...", "time_block": "...", "activity_name": "...", "location_name": "...", "span_blocks": 1 }
      ] }
  ]
}
```

New `format_version: 1` — sibling to, not a mutation of, the existing group-schedule contract
(`exportScheduleJson.js`, also `format_version: 1`) and the existing elective-run export
(`exportElectiveRun.js`). No staff-reachable path is added: the new IPC channel requires
`elective_assignment_runs.read`, which D9's table grants to `admin` only and `staff` not at all —
the same implicit gating `exportElectiveRun.js` already relies on, inherited rather than
reinvented.

### e. The D8 encryption gate as a visible statement

**New IPC channel: `shoresh:get-security-status`** (read-only, no `authorize()` call needed — this
is public configuration state, not camper data, the same class of read as `getCamp`):

```
getSecurityStatus() -> { atRestEncryptionEnabled: boolean }
```

Reads `process.env.SHORESH_AT_REST_ENCRYPTION` (or equivalently, whatever `docStore.js` already
resolves it to internally — the handler must call the **same** resolution function `docStore.js`
uses, not re-parse the env var independently, so the two can never disagree).

**Where it renders:** `src/screens/elective/assignment/AssignmentPanel.jsx`'s "No run" (empty)
state — the feature's entry point per T199's own director-flow table — gets a persistent,
non-dismissible line (not a banner; a fixed disclosure row, matching how other permanent
disclosures already render in this codebase's admin screens) reading approximately: *"Camper data
in this feature is not yet encrypted at rest. Do not use real camper names until this is enabled."*
It renders whenever `atRestEncryptionEnabled === false`, and does not render (or renders a neutral
confirmation) when `true`.

**Test pin:** a component test on `AssignmentPanel` asserting the disclosure text is present when
`getSecurityStatus` mocks `false`, and a second test (or the same test's second assertion) that it
is present regardless of which director-flow state the panel is in initially reached from — not
just the very first render — so a future refactor that guards it behind a one-time render cannot
silently drop it. This is the invariant T249 pins.

## Interface-contract checklist (per `org-interface-contracts`)

| Channel | Idempotent? | Concurrent-retry safe? | Unknown-outcome handling | Error shape | Scope boundary |
|---|---|---|---|---|---|
| `finalize-elective-run` | Yes — re-check `status` before acting; `ALREADY_FINAL` on retry | Partial — same-content retries converge; a **set-membership** divergence from a not-yet-synced concurrent regeneration is not preventable (inherent to eventual consistency) and is instead detected post-merge via `FINALIZED_AGAINST_STALE_GENERATION` (H2 fix) | Caller retries; sees `ALREADY_FINAL` if it actually applied, or re-runs validation if it didn't; a post-merge detection finding is surfaced separately, not returned synchronously by this call | `{ok:false, error, findings?}` | `elective_assignment_runs.write` (existing action, admin-only via D9) |
| `set-elective-assignment` | Yes — same derived row as solver writes, re-submitting the same move is a no-op write | Yes — per-field LWW on one row, no new row created per retry; the row's `source='manual'` exemption from the generation predicate (H3 fix) is what makes a lock durable against a concurrent, independently-timed regeneration on another device | Caller retries; worst case is a harmless re-write of the same values | `{ok:false, error}` | same action as above |
| `get-elective-run-outer-schedule` | N/A (read) | N/A | N/A | throws on missing/invalid args, matching `getElectiveRunHandler` | `elective_assignment_runs.read`, admin-only |
| `get-security-status` | N/A (read) | N/A | N/A | throws only on IPC transport failure | no `authorize()` — non-camp, non-PII config read, same class as `getCamp` |

Data crossing a trust boundary: none of these four channels accept data from outside this app's own
writes (no import, no sync-originated payload parsed here) — `set-elective-assignment`'s
`activityId`/`occurrenceId` are validated against this camp's own `elective_occurrences`/`activities`
rows already in the projection, which is the existing "don't re-validate our own writes" case, not a
new trust boundary.

**Decomposition: parallel development, sequential merge — say it that way, not just "parallel."**
T244, T245, T248, and T249 are developed independently and can be built and reviewed in parallel;
they are not independent at merge time, because all four append handlers to the same two files
(`electron/main.js`, `electron/preload.js`). Each ticket's Dependencies section already names the
required append order (T244 → T245 → T248 → T249) to keep that a mechanical git conflict rather than
a logic dependency — this is a merge-order constraint, not a build-order constraint, and the two
should not be conflated when reading "parallel" in any ticket's Dependencies section.

## Reused vs. new

**Reused:** D4's derived-id discipline (extended, not reinvented, to the snapshot table); D5's
`solver_generation` column (now enforced, not newly designed); `routeConflicts.js` (T193, called
from a new caller, unmodified); the `{ok:false, error}` refusal shape `commitElectiveRunHandler`
established; the `requireAuthorized(..., 'elective_assignment_runs.write'/'.read')` action names
(no new permission entries); `collectSpanTails`/`getActivityRowSpan` (reused for export
span-awareness); **`minCostAssign` itself, called a second time unmodified** for the linked-choice
tier (corrected claim — the original text said the flow *topology* was extended in place; it is
not: `minCostAssign` operates on a flat per-column `capacity[]` vector with no notion of an edge
between columns, so a chain/graph topology cannot be expressed inside it at all, and the corrected
design does not attempt to — it calls the same function twice over two different row/column
framings instead).

**New:** `elective_run_outer_snapshots` table (now including its `solver_generation` column, H2);
`finalized_at`/`finalized_by` columns; four IPC channels (two write, two read); the tier-1
choice-level bipartite pass in the flow network (reusing, not replacing, `minCostAssign`); the
`lockedAssignments` engine parameter; the generation-visibility predicate's `source='manual'`
exemption (H3); the `FINALIZED_AGAINST_STALE_GENERATION` detection finding (H2), now with a rendered
surface in T250's Final state; the `overCapacityOccurrences` post-merge detection finding (residual
of H3, owned by T244); the `DANGLING_MANUAL_ASSIGNMENT` finding (residual of H3, owned by T246); the
cross-handler roster-parity fixture test (residual of MEDIUM-4, owned by T248); the child-schedule
export utility and its `format_version: 1` contract; the security-status read path.

## ADR required: yes

This is filed as this document. It changes a shipped IPC contract's callable surface (four new
channels), introduces a new persistent table and two new columns other code will depend on
(`elective_run_outer_snapshots`, `finalized_at`/`finalized_by`), and makes a tradeoff that is not
obviously reversible in the direction it's made (immutable-final-run as the default lifecycle
shape) — all three of the constitution's ADR triggers apply.

## Owner rulings — 2026-09-23

All six questions below were ruled on by the owner on 2026-09-23. The rulings are recorded here;
the question text is preserved unedited beneath, so a later reader can see what was asked, what was
recommended, and what was actually decided — not a document that always said the right thing.

**Q1 / Q2 — Option A. Immutable, no reopen. A revision is a new run.** Accepted **as a package**
with the `FINALIZED_AGAINST_STALE_GENERATION` detection (decision (a)) and its rendering as a
finding, never a banner (T250). **This conditionality is binding.** If the detection does not ship
inside T244 alongside finalize, or T250 does not render it, the immutability ruling does not hold
and the question returns to the owner. Neither piece may be deferred out of those tickets.

**Q3 — Option A. No discount; repeats are scored independently per occurrence.** The accepted
consequence, in the owner's own terms so that nobody later reads it as an oversight: **one camper
can take every occurrence of a popular activity while another camper who ranked that activity gets
none of them, and the scheduler will not treat that as wrong.** That is the ruling, not a defect to
be quietly patched by a future implementer who finds it surprising.

The owner may revisit after seeing real output. For that escape hatch to be real, the output has to
exist: **T247 must make the solver's per-camper repeat distribution an actual reported figure** on
the 100-camper fixture (how many campers received the same activity 2x, 3x, ... across the week, and
the distribution of how many ranked-but-unplaced campers that coincided with), not merely a number
someone could compute by hand from the assignment dump. A revisit trigger nobody can observe is not
a revisit trigger.

**Q4 — Option A. Build now against fabricated fixtures.** Real camper data stays refused at the
visible, tested UI gate until at-rest encryption ships and defaults on. T249 keeps that gate in
scope; it is a release precondition per T199, not a nice-to-have.

**Q5 — Deferred, as recommended.** Director-facing terminology is decided once, against a real
screen, in T250's copy pass with Designer.

**Q6 — Option A. The loss of D11's joint-optimality guarantee is accepted for this slice.** The
owner weighed this specifically against his own "no camper systematically shortchanged" reasoning in
D11 and accepted it.

> **This is a KNOWN, ACCEPTED divergence from D11, and it is revisitable — recorded here so that it
> cannot become permanent by omission.** An accepted tradeoff that nobody wrote down as revisitable
> is indistinguishable from a bug six months later.
>
> - **What is given up:** the two-tier solve compares linked choices and unlinked preferences in two
>   sequential passes, never jointly. D11's provably-optimal guarantee therefore does not hold
>   across that boundary.
> - **Who is affected, precisely:** a camper who ranks **both** a linked choice **and** a scarce
>   unlinked activity. Tier 1 can commit that camper to the linked choice before tier 2 ever weighs
>   the unlinked preference. No other camper shape is affected.
> - **Revisit trigger:** real catalog data from T218 (third-party export format) and T219 (multi-day
>   catalog linkage). If that data shows linked choices are common and overlap with scarce unlinked
>   demand is real, the tier-1 rewrite to a general graph solver is the fix, and this ruling is
>   reopened on those grounds.

## Open questions — owner judgement required

*Ruled on 2026-09-23 — see "Owner rulings" above. Kept unedited below as the record of what was
asked and recommended.*

These are product-facing decisions this design deliberately does not make. Each names the options,
what each costs operationally, and a recommendation with confidence — not a bare choice.

**Q1. What does "start a revision" mean to a director, once a run is final?**
- *Option A — new run only (no reopen).* The prior final run stays as a permanent record; a
  revision is a fresh import against the same week/route/division. Cost: a director who wants to
  fix one camper's placement after finalizing has to redo the whole flow (though locked seats from
  the old run could, in a later slice, be carried into the new one as a starting point — not
  designed here). Benefit: zero new state-machine risk, nothing to secure against "can a final run
  quietly drift."
- *Option B — explicit reopen, back to draft.* Adds a `reopen` IPC, invalidates the snapshot, and
  reintroduces every finalize-time question (staleness, conflicts) on re-finalize. Cost: a second
  state machine, more surface for Security/Red Hat to review, and a director-facing question of
  "does reopening un-finalize an artifact staff may already hold a copy of" that has no clean
  answer once export has happened.
- **Recommendation: Option A, high confidence — revised 2026-09-23.** This is what the technical
  design above assumes. It is the smaller, safer default and is purely additive to change later —
  Option B can be built on top of Option A without touching anything designed here. The operational
  cost (redo the whole import to fix one seat) is real but bounded, and directors already have the
  move/lock UI for in-draft corrections, which covers the common case.

  **Revised condition on this recommendation, after Red Hat H2.** A genuinely reachable state was
  found where an immutable final run is *silently wrong* — Device A finalizes against a generation
  that a since-synced Device B had already superseded before the merge landed (see decision (a)'s
  H2 fix). Recommending immutability **without** the paired `FINALIZED_AGAINST_STALE_GENERATION`
  detection finding would be irresponsible; with it, the recommendation still holds, because the
  design's standing philosophy throughout this feature is "detect and surface, never silently
  succeed" (the same posture D5, D6, and D10 already take), and this closes the one place immutable
  + no-reopen would otherwise have violated it. **The detection finding is not optional polish — it
  is now scoped inside T244, not a follow-up**, and this recommendation should be read as
  conditional on that landing together with finalize itself, not after.

**Q2. Is a finalized run immutable, or can a director still move/lock a camper after finalizing?**
This is the same question as Q1 from a different angle — Option A above implies immutable-after-
final. **Recommendation: yes, immutable, same confidence as Q1, under the same revised condition**
— an editable "final" state is a contradiction in terms with what T199's own director-flow table
calls it ("Read-only run identity...").

**Q3. Does the scoring rule treat repeats of the *same* activity as fully independent, or does a
camper's second placement in an activity they already got cost something (diminishing preference)?**
D14's correction already ruled "repeats are normal" — a camper may be placed in the same activity
twice. What D14 did **not** rule on is whether the *cost function* treats the second placement
identically to the first, or discounts it (e.g., to avoid one camper monopolizing a popular
activity's every occurrence at the expense of a camper who got nothing). - *Option A — no discount,
fully independent scoring per occurrence.* Simple, matches D14's literal ruling, but a popular
activity with light demand could see the same handful of campers placed in every occurrence of it.
- *Option B — declining marginal cost for repeat placements of the same activity for the same
camper.* Fairer in the "spread the good stuff around" sense a camp director would likely want, but
is a new, currently-undefined cost-function parameter with no real data to calibrate it against.
**Recommendation: Option A for the first ship, low-medium confidence** — it is what D14 literally
ruled, it requires no new undefined constant, and it is observable/measurable (T196's own
100-camper fixture already has the instrumentation) if the owner wants to revisit after seeing real
output.

**Q4. Does this feature ship gated entirely behind the D8 encryption block, or does draft/testing
work proceed against fixture data now with the gate only blocking real camper data?**
T199 already states fixture-only use is fine pre-encryption; this question is really "should T199's
slices (T243-T251 below) be built now, or parked until `SHORESH_AT_REST_ENCRYPTION` ships and
defaults on?" - *Option A — build now against fixtures, gate real use at the UI (as designed in
(e)).* Keeps this program moving; the gate is a real, tested, visible control, not a promise.
- *Option B — park all remaining slices until encryption ships.* Avoids any chance the visible gate
is later found insufficient (e.g., a support/debug tool that reads the raw db). **Recommendation:
Option A, high confidence** — this is what T199 itself already specifies ("built, tested, and
demonstrated against fixture data"), the risk Option B avoids is a general SQLite-at-rest risk this
feature does not make worse or better, and parking a designed, reviewed feature on an unrelated
program's timeline is a larger cost than the risk it avoids.

**Q5. Terminology — what should a director-facing screen call these five concepts?**
This design and the 09-17 ADR use `run` / `choice` / `offering` / `occurrence` throughout, which are
implementation nouns, not words a camp director uses. No screen has been drafted with real copy
yet (T250 is where this first becomes visible). **Recommendation: defer the actual words to T250's
copy pass with Designer, medium confidence** — guessing director vocabulary here without a UI to
react to would likely produce copy that gets rewritten anyway; better to decide it once, against a
real screen, than twice.

**Q6. Is the two-tier linked-choice construction's loss of D11's joint-optimality guarantee an
accepted tradeoff, or does it need a different design?**
Decision (c) reuses `minCostAssign` twice, sequentially — tier 1 (linked choices) solves and commits
before tier 2 (everything else) ever runs. This means a camper who ranks both a low-ranked linked
choice and a high-ranked unlinked preference for a scarce activity can be placed into the linked
choice by tier 1 before tier 2 has any chance to weigh the unlinked preference against it — no joint
solve ever compares the two, which is structurally the priority-class greedy D11's min-cost-max-flow
choice was adopted specifically to avoid ("a provably optimal assignment," the safeguard against "the
computer could have given Sara her third choice and didn't").
- *Option A — accept the loss for this slice, scoped to campers who rank both a linked and a scarce
  unlinked preference.* Ships now, reuses the existing solver unmodified, costs nothing new to build.
  The size of the affected population is unknown (depends on how common linked choices and
  overlapping preferences are in a real catalog — T218/T219 territory, not yet answered).
- *Option B — a single joint solve (ADR candidate (1) from decision (c)'s divergence: a general
  graph min-cost-flow rewrite replacing `minCostAssign`).* Restores D11's guarantee in full. Cost: a
  genuine rewrite of the solved, tested core of T196, not a drop-in, undertaken before any real catalog
  data has confirmed linked choices are common enough to justify it.
**Recommendation: Option A, low-medium confidence** — the same reasoning as the overlapping-choice
scope line elsewhere in decision (c): building the general solver now, before real data (T218/T219)
shows linked choices are common and preference overlap with scarce activities is real, risks
over-building against a shape that may not occur. Confidence is lower than the ADR's other
recommendations specifically because D11's optimality promise was itself owner-facing reasoning, not
purely a technical judgment call — this is the recommendation to weigh most carefully against the
owner's own sense of how much the original "no camper systematically shortchanged" promise matters
relative to shipping this slice now.
