---
title: Elective follow-ups T218 and T219 — handoff
document_type: handoff
status: active
created: 2026-09-18
task: docs/adr/2026-09-17-individual-elective-scheduling.md
archive_when: both T218 and T219 are closed, or superseded by a later handoff
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
related_tickets: [docs/work/tickets/T218-elective-export-third-party-adapter.md, docs/work/tickets/T219-multi-day-catalog-linkage.md]
---

# Elective follow-ups — T218 and T219

**The individual-elective programme SHIPPED on 2026-09-18.** These two tickets are what is left, and
neither blocks anything. Read this before planning either: both were written early, and the ground
under them moved.

## What already exists — do not rebuild any of it

All merged to `main` on 2026-09-18.

| capability | module | ticket |
|---|---|---|
| offering-grid import (day × period, which activities run) | `src/ingest/electiveSetPopulate.js` | T195 |
| camper + ranked-preference parse | `src/ingest/preferenceSheet.js` | T226 |
| deterministic camper identity | `electron/ops/electiveDerivedIds.js#deriveCamperId` | T226 |
| the solver | `src/engine/buildElectiveAssignments.js` | T196 |
| atomic commit through the op log | `electron/ops/commitElectiveRun.js` | T196 |
| IPC seam, admin-only by inheritance | `commit-elective-run` / `list-elective-runs` / `get-elective-run` | T227 |
| the director-facing flow | `src/screens/elective/assignment/` | T229 |
| export (Excel + JSON) | `src/screens/elective/assignment/exportElectiveRun.js` | T229 |

`PLATFORM_STATE.md`'s header notes from 2026-09-18 carry the detail. Read those before the tickets —
several ticket bodies predate the implementation.

## Standing owner rulings — settled, do not reopen

1. **Never unplaced.** Best available choice, flagged; last resort places into anything with room.
2. **Repeats are normal.** A camper swims twice a week. No per-choice cap.
3. **Fairness is not modeled.** Deliberate deferral pending real output, not an oversight.
4. **Camper IDs are assumed present on the sheet** (2026-09-18). Do not re-gate on a real import.
5. **Export is not bespoke** — Excel or JSON at the director's choice, reusing existing primitives.
   Do not add a third general export path.
6. **Propose, never merge** (T144, reaffirmed by T232). No name-matching heuristic may auto-apply.

---

# T218 — third-party export adapter

## Status: DE-GATED, still unknown

The owner ruled on 2026-09-18: assume camps can supply a camper id, and **do not wait for a real
export before building**. That ruling already unblocked T226/T196/T229, which shipped without it.

**What makes this affordable is the mapping layer.** `inferPreferenceMapping(header)` proposes a
column layout from the header row and the director corrects it, so an unseen export shape is a
MAPPING, not a code change. If anyone ever hardcodes a layout, this ticket becomes blocking again —
that property is the whole reason the assumption is safe.

## What is genuinely unknown

Nobody has seen a completed camper response. The artifacts examined were **blank forms and catalog
sheets**. The real submissions arrive through a third-party portal (CampMinder or similar) whose
export format nobody has.

## What a session picking this up should actually do

**Do not design an adapter for a format you have not seen.** That is what produced T195 round 1,
which was built against an imagined format and deleted.

Useful work that does NOT require the artifact:
- Harden `inferPreferenceMapping` against shapes we can reason about generically: a header row that
  is not row 1, merged/blank leading columns, ranks expressed as `1st`/`2nd` rather than `#1`,
  a single "choices" column holding a delimited list.
- Each of those is testable with a fabricated fixture and makes the mapping layer absorb more without
  a code change.

Work that DOES require the artifact — park it until one exists:
- Any named-vendor adapter.
- Any assumption about how a portal encodes divisions, ranks, or camper ids.

## Evidence that will matter when an artifact arrives

A fabricated 100-camper sheet produced same-name collisions at a **13% rate by accident**. If real
camps have siblings or common names at anything like that rate, the camper-id column is the
difference between importing and blocking on a sixth of the roster. Worth confirming with the camps
before the first real import rather than after.

---

# T219 — multi-day catalog linkage

## Status: OPEN, and the most likely next real slice

T195 detects linkage glyph markers on a cell's raw activity name and surfaces them in
`linkageMarkers: [{ dayIndex, periodIndex, activityName, markerType, sourceExcerpt }]` — and
**never applies them.** Nothing infers a span, writes a multi-block elective set, or touches
`activities.span_blocks` / `is_span_head`. That inference is this ticket.

## Why it is harder than it looks

Linkage is a property of the camp's **offering catalog** — "Water Ski spans two periods", "Ropes
repeats Monday/Wednesday/Friday" — not something a camper expresses. So it touches
`elective_sets` membership across MULTIPLE (day, time_block) pairs at once, which is a materially
different write shape from T195's per-(day, time_block) upsert.

## What changed under this ticket since it was written

**The solver now exists**, and it assumes one activity per (camper, occurrence). A linked multi-period
choice breaks that assumption: placing a camper into a two-period Water Ski consumes TWO occurrences
atomically. `elective_choices.is_linked` and `elective_choice_offerings` were modeled for exactly
this (T194, ADR D12 — "a single choice is the degenerate one-member case, so there is ONE code path"),
but `buildElectiveAssignments` does not read `is_linked` today.

**So this ticket is now two pieces, and they can ship separately:**
1. **Catalog side** — infer a span/repeat from a marker and write it. Needs the glyph convention
   confirmed, which is still unverified (the real offering sheet is outside the repo).
2. **Solver side** — honour `is_linked` when placing, so a linked choice occupies all its
   occurrences or none. This needs NO artifact and can be built and tested today against fabricated
   linked choices. **This is the recommended starting point.**

## A caution specific to the solver side

`buildElectiveAssignments` solves occurrences in a deterministic order, one min-cost flow each. A
linked choice spanning occurrences that are solved at different times cannot be placed atomically by
that loop as written — the second period may be full by the time it is reached. Expect to either
reserve linked placements before the per-occurrence pass, or treat a linked choice as a single unit
in a combined pass. **Design this before writing it**; it is the one place the current solver's shape
genuinely resists the feature.

---

## Process notes that cost real time on 2026-09-18

These are not incidental — each produced a failed gate or a wrong claim.

- **Read a CI run's `conclusion`, never a wrapper's exit code.** `gh run watch --exit-status`
  returned 0 on a failed run. Four separate false greens in one day. Capture exit codes inside the
  command: `cmd > log 2>&1; echo "EXIT=$?"`. Never `| tail` inside an `&&` chain — the pipe's status
  is what the shell reports.
- **Check the CI SHA matches your head.** A green conclusion on a pre-rebase commit describes a tree
  that no longer exists.
- **`check:governance` reads COMMITTED state.** Running it before committing answers a question about
  the previous commit. Anything touching `src/screens/**`, a migration, or an ADR needs a
  PLATFORM_STATE note written as part of the change — it bit four times in one day otherwise.
- **Derive ticket numbers from the REMOTE** (`git ls-tree origin/main` plus remote branches), not the
  local tree. Two collisions (T222, T228) came from a local read while a peer session was merging.
- **A new IPC channel needs THREE parities**: `electron/preload.js`, a `src/localClient.js` wrapper,
  and `src/localClient.mock.js`. Only CI caught the missing wrapper.
- **The gate lock is machine-wide.** If `npm run verify` blocks, a peer session holds it. Wait; do
  not set `SHORESH_VERIFY_NO_LOCK`.
- **The dev database is at schema v53** and migrates to v69 on first launch. Verified safe on a copy
  (89ms, integrity ok, 0 FK violations, 675 `template_slots` preserved) — but it has not been run in
  the packaged app.

## The one methodological lesson worth inheriting

Eight defects were found on 2026-09-18. **Every one came from running something; none from reading
code.** Two were in code that had been merged and reviewed months earlier and had been reporting
success the whole time.

Four claims made from reading structure were wrong: that capacity drove placement variety (it is the
offering MENU), that occurrences come from `elective_sets.day_id` (they come from `template_slots`),
that a `runId` default was a live hazard (it is display-only), and that a misspelled division yields
no campers (it yields a camper eligible everywhere).

**A schema column tells you what is DECLARED — never what ARRIVES, and never who READS it.** Grep the
caller before citing the column, and run the thing before believing the explanation.

## Outstanding, not owned by either ticket

**No part of this feature has been exercised in the packaged app.** Everything is verified in tests,
headlessly, and in browser-dev against staged fixtures. Given the above, that is where the next
defect most likely lives. The owner was doing a hand pass as of 2026-09-18; check with them before
assuming it is clean.
