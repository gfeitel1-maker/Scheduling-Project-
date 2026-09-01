---
title: "Export testing protocol"
document_type: reference
status: active
created: 2026-09-01
governing_docs: [docs/work/plans/2026-09-01-machine-access.md]
---

# Export testing protocol

How we keep the schedule export (JSON + Excel) trustworthy: a file must say
exactly what the schedule says — nothing dropped, invented, or distorted — and
its shape must not shift under a downstream tool's feet.

Scope note: the **JSON** export (`format_version` 1, `buildScheduleExport`) is
structured, so it gets the full fidelity guarantee below. **Excel** is
human-facing and deliberately lossy (a cell reads `"Afternoon Chugim (Swimming,
Kayaking)"` — a sentence, not data), so Excel is tested for *correct labels*
(`exportSchedule.test.js`), not round-trip. Both formats share one cell resolver
(`src/utils/scheduleCells.js`) so they cannot disagree about a cell's content.

## Layer 1 — backbone (automated, runs on every export change)

The committed guarantee. One "everything-in-it" coverage fixture
(`src/utils/exportScheduleRoundTrip.test.js`) exercised three ways:

1. **Round-trip** — the export survives `JSON.stringify`→`parse` unchanged (no
   `undefined`/`NaN`; unicode/Hebrew intact).
2. **Golden fidelity** — the emitted cells equal a hand-authored expected set:
   every cell kind (activity, anchor, event, elective-with-members) and every
   edge (empty cell omitted, dangling activity/event/elective, multi-block span,
   unicode name), in exact order, nothing dropped/added/distorted.
3. **Envelope + version** — camp/week/route/axes correct, `format_version` pinned.

Supporting unit tests: `scheduleCells.test.js` (resolver + label formatter),
`exportScheduleJson.test.js` (builder shape), `exportSchedule.test.js` (Excel
labels).

**Standing rules:**
- Any change to export or to the cell shape runs Layer 1.
- A change to the JSON **shape** (add/remove/rename a field) MUST bump
  `format_version` and update the golden fixture in the round-trip test — the
  version is a public contract for downstream consumers.
- Never delete a golden assertion to make a diff go away; a diff is either a bug
  or a deliberate, version-bumped change.

## Layer 2 — reality (run on a cadence / before relying on a real camp)

Fixtures are tidy; real camps are not. Export against real, built schedules and
sanity-check the results:

- The dev camp (`~/Library/Application Support/shoresh-dev/shoresh.sqlite`) via
  `export_schedule` — confirm cell counts and kinds match what the Schedule
  screen shows.
- Schedules built from the real prior-year files in `~/Desktop/camp schedules/`
  (Camp Mindy 2025, Group Schedules, …) — import → build → export → eyeball.

Not committed (it runs against mutable databases); it is a runbook step.

## Layer 3 — director's eye (before shipping a schedule somewhere)

- Compare an exported file to what's actually on the grid for a known camp.
- Load the JSON into the tool it's destined for and confirm it's consumable —
  a format that is technically correct but unusable downstream is not done.

## What good looks like

Layer 1 green on every change; Layer 2 clean before a real camp depends on the
export; Layer 3 spot-check before a schedule leaves the app for another system.
