---
title: "A run is named after the import event, never after one file"
document_type: ticket
status: completed
created: 2026-09-29
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
related_runs: [docs/work/runs/2026-09-29-t319-import-event-run-name.md]
related_tickets: [docs/work/tickets/T303-caller-declared-arrival-on-the-machine-path.md, docs/work/tickets/T299-identical-submissions-are-not-one-camper.md, docs/work/tickets/T244-finalize-elective-run-ipc.md]
archive_when: "an elective run's name is the import event (local date and time to the minute plus how many preference sheets that import read), produced by one shared pure function used by the CLI, the director's panel and the dev mock; a second byte-identical arrival onto an existing run leaves that run's name and source_filename untouched; an explicit --name/run_name still wins — each asserted by a test that goes red when the production change is reverted"
---

# T319 — A run is named after the import event, never after one file

Owner ruling, 2026-09-29, verbatim: **"no idea what this means. you can suggest a fix."** — said of
T303's first known limit. The suggested fix the owner accepted for implementation: **name a run after
the import event, never after one file's name.**

## What a director experiences today

Two children hand in preference sheets that happen to be byte-identical — a camp offering eight
things, and archery and swim are the obvious two picks. Their files are named after themselves,
`ari.csv` and `noa.csv`. Both are imported. The saved-runs list shows **one** run called `noa.csv`.

Nothing is lost: each child keeps her own label, her own answers and her own coordinates (T299,
T303). What is wrong is the run's label, and the way it is wrong is the worst kind — it is a specific,
confident, false statement. A director reading `noa.csv` has no way to know Ari is in there too.

## Why

The run id is **content-derived** (`deriveImportedElectiveRunId`), deliberately, so a machine
re-sending the same bytes after an ambiguous timeout converges onto one run instead of duplicating.
That part is right and is not in scope here (T303's own non-goal).

The defect is one layer up. `electron/ops/commitElectiveRun.js` writes `name` and `source_filename`
**unconditionally on every commit**, so the last arrival wins. `status` in the same call is already
guarded `existingRun ? undefined : 'draft'`, for the same class of reason (T244: a late-arriving
regeneration must not revert a finalized run). T303 named the two-line change and deliberately did
not take it, because it changes re-commit behaviour for every caller. This ticket takes it, with that
examination done.

And the name itself was never a good name. Every writer reached for a filename or a bare date:

| writer | today |
|---|---|
| `scripts/preferenceSheetCli.js` (CLI and MCP door) | `runName ?? path.basename(file)` |
| `src/screens/elective/assignment/AssignmentPanel.jsx` (director's panel) | `` `Elective assignment — ${date}` `` |
| `src/localClient.mock.js` (browser dev mock) | whatever the caller passed |

A filename is the wrong fact to put in a run's name at all. A file name is one arrival's property; a
run is an import event that may collect more than one arrival.

## What changes

1. **One shared pure function** produces the name: `importEventRunName({ at, sheetCount })` in
   `src/ingest/importEventRunName.js` — dependency-free so the renderer, the node CLI and the mock
   can all import it. Format: `Import 2026-09-29 14:02, 32 sheets`; local date and time to the
   minute; `1 sheet` singular.
2. **`sheetCount` is how many campers' preference sheets that import read** —
   `parsed.campers.length`, the same `parsed` the caller hands to the commit. One child's own planner
   reads as `1 sheet`; a director's matrix of thirty-two children reads as `32 sheets`. Defined once,
   derived the same way by every door, so the number cannot mean different things through different
   doors.
3. **An explicit `--name` / `run_name` still wins.** A machine caller that names its own run keeps
   that name; the event name is the default, not an override.
4. **`name` and `source_filename` are asserted only on a run's first creation**, exactly the way
   `status` already is. A second byte-identical arrival does not rename the run. `source_filename`
   then names the run's *first* arrival, which is a true statement about that run, rather than a
   joined list nobody asked for.

## What does not change

- The run id stays content-derived. Identical bytes are one run, however many arrivals declare them.
- No schema change. No new column — there is no per-sheet filename column and this ticket does not
  invent one (`source_filename` on `elective_assignment_runs` is the only one in `schema.sql`).
- Per-camper and per-sheet provenance stays exactly where it lives. Each camper still carries her own
  label from her own file (T299/T303/T313); the run's name is not where a director learns who is in
  it.
- `src/screens/elective/run/RunList.jsx` is untouched. It already shows `run.name` and
  `run.source_filename`; both become truthful without a render change.

## Known limit at close

**The count is only as informative as the door's shape.** A CLI invocation commits one file, and a
single child's planner carries one camper, so that door will usually read `1 sheet`. The count earns
its place on the panel's matrix import and on any future multi-file door; on the machine path it is
a constant most of the time. It is still a true statement, and the timestamp is what distinguishes
two machine imports from each other.

**A second arrival is invisible in the run's label.** Two byte-identical arrivals now produce a run
named after the *first* import event, and nothing in that name says a second arrival joined it. That
is the deliberate trade: a stable, honest name beats a name that rewrites itself. The campers are
where the second arrival is visible, and the attention surface lists both children by their own
names.

**Two devices importing the identical bytes before syncing can still produce an internally
inconsistent pair.** The run id is content-derived and `existingRun` is a purely local sqlite read, so
two devices that each import the same bytes before either has seen the other's write both believe
they are creating the run. Once the per-field LWW merge settles, the surviving `name` (one device's
clock) and the surviving `source_filename` (possibly the other device's file) need not agree with each
other. Not prevented by this ticket — closing it would mean deriving the run id from the declared
arrival, which is the non-goal T303 already declined and this ticket does not reopen.

**The panel's re-commit safety rests on an invariant this ticket did not have to build, only rely on.**
`AssignmentPanel.jsx` can only re-commit onto an existing `runId` through `regenerate()`, which always
re-solves against the same `parsed` already on the run — so the name/sheet-count this guard suppresses
on that path would have been identical anyway. A future affordance that let a director swap the source
file while keeping the template (same `runId`, new `parsed`) would break that: the run would keep a
stale name and a stale sheet count permanently, since the first-creation guard never re-asserts them.

**A wrong system clock writes a label nothing can later correct.** The name is stamped once, at first
creation, from the creating device's own local clock, and never recomputed — every viewer renders the
stored string verbatim regardless of its own timezone, which is deliberate. The cost is the mirror
case: a machine with a wrong clock or timezone writes a permanent, wrong label, and not even a retry
from a device with a correct clock can fix it, because the retry lands on the same content-derived run
id and the first-creation guard suppresses its name. Separately, the panel's previous name used a UTC
date and this one uses local date/time, so a commit near local midnight can show a different calendar
date than the old format would have shown for the same wall-clock moment.

**"Sheets" is this app's own word for one child's preference form, not a file count.** A director's
32-row matrix import reads `32 sheets` — true in the assignment screen's own vocabulary (T229) — but a
director meeting that word cold in the runs list, with no matrix in view, could read it as a count of
files. Flagged, not changed: the owner accepted this format as written.

**The panel never sends `source_filename` at all.** Every panel-originated run therefore stores
`source_filename: null`, and the runs list shows no file metadata for it. This is pre-existing and
unchanged by this ticket, recorded here so "`source_filename` names the run's first arrival" above is
not read as a promise the panel door keeps — it is a promise about the CLI/MCP door only.
