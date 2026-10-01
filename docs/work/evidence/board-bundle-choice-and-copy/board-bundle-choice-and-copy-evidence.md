---
title: board-bundle-choice-and-copy — live visual evidence for round 3/4
document_type: evidence
status: completed
created: 2026-09-30
governing_docs: [docs/governance/constitution/CONSTITUTION.md]
---

# board-bundle-choice-and-copy — what the director actually sees

## History of this evidence (read this first)

Round 3's report claimed "Screenshots confirm, live" for three scenes but no
PNG file was ever written to disk — the Browser pane's screenshot tool
returns an inline image to the calling context only, with no file-output
parameter, and none was separately saved. That was a real gap, correctly
caught by the Governor's audit (no PNG on this machine from that time
window). I do not dispute it.

**First remediation attempt** (kept as `scene1-sheet-only-campers-and-finalize-position-get_page_text.txt`,
`scene1-accessibility-tree-read_page.txt`, `scene2-outer-resource-conflict-refusal-get_page_text.txt`,
`scene3-finalized-run-get_page_text.txt` in this directory): re-drove the same
three scenes in the Browser pane and captured them as text via
`get_page_text`/`read_page`, which *do* return retrievable text. I explicitly
did not connect to a Chrome instance I found running on this machine with
`--remote-debugging-port=9333`, because its `/json/list` showed tabs on a
different port (5241) — a different session's browser, not mine — and
capturing whatever was frontmost there risked photographing another
session's private content.

**Second, successful attempt** (this file, plus the `.png` files below):
discovered this repo already has precedent for exactly this problem —
`docs/work/evidence/T249/capture.mjs` uses Playwright, which launches its
OWN fresh, isolated browser (no shared debugging port, no risk to another
session), and writes real screenshot files via `page.screenshot({ path })`.
Playwright itself was not an installed project dependency, so the browsers
were already cached (`~/Library/Caches/ms-playwright`) and the npm package
was installed to a scratch directory (`npm install playwright --no-save`
under `/tmp`, never touching this repo's `package.json` or `node_modules`)
and run with that scratch install's `node_modules` as the resolution root.
`capture.mjs` in this directory is the reproduction script — same idea as
T249's, adapted to this task's three scenes.

## What the screenshots show

Captured against `npx vite --port 5301` (port 5200 on this machine was
already occupied by a different worktree's dev server — confirmed via
`lsof -p <pid>` showing a different cwd) with the mock local client. Every
name is fabricated — "Camp Fixture Test", "Director Dana", "Noa Katz", etc.
No real camp or camper data is involved.

The fixture is seeded via `page.evaluate` calling the SAME mock functions
the real UI calls (`write`/`commitElectiveRun`/`finalizeElectiveRun`), not
hand-written `localStorage` JSON — so the seeded state is exactly what those
functions produce for a real import, not a fabricated read-model.

| File | What it shows |
| --- | --- |
| `scene1-draft-run-mismatches-and-sheet-only.png` | Cold-opened Draft run "Week 1 — mismatches demo": Finalize renders ABOVE the run-state findings area (C1 ii), and the sheet-only-campers disclosure is expanded, showing the count + names row (C(4)), durable on a cold reopen. |
| `scene2-outer-resource-conflict-refusal.png` | A REAL click of "Finalize run" (not a jsdom-mocked IPC response) against a run whose template_slots double-book the Boathouse — produces a live OUTER_RESOURCE_CONFLICT refusal naming the location, day/period, capacity and colliding activities (F8 + C2/F6): "Boathouse on Monday, Period 1 is double-booked over its capacity of 1: Canoeing and Canoeing and Canoeing and Kayaking are scheduled there at once." The raw kind code never appears. |
| `scene3-finalized-run-director-name.png` | Cold-opened Final run "Week 0 — finalized demo": "Final · finalized 2026-10-01 · by Director Dana" — the real director's name, never a raw user id (C3). |

`capture.mjs`'s own console output (`SEED RESULT`), reproduced here for the
part that matters most — confirms `commitElectiveRun` really did compute 4
`BUNDLE_TIER_NOT_COVERED` findings across the two seeded (label, tier) pairs
when called directly:

```
"findings": [
  { "kind": "BUNDLE_TIER_NOT_COVERED", "camper_id": "cam-y1", "label": "Ropes", "tier_id": "tier-younger" },
  { "kind": "BUNDLE_TIER_NOT_COVERED", "camper_id": "cam-y2", "label": "Ropes", "tier_id": "tier-younger" },
  { "kind": "BUNDLE_TIER_NOT_COVERED", "camper_id": "cam-o1", "label": "Climbing", "tier_id": "tier-older" },
  { "kind": "BUNDLE_TIER_NOT_COVERED", "camper_id": "cam-o2", "label": "Climbing", "tier_id": "tier-older" }
]
```

PAGE ERRORS: none.

## Two things honestly surfaced by this evidence, neither fixed here (out of round-4 scope)

1. **The grouped `BUNDLE_TIER_NOT_COVERED` rows do NOT appear in
   `scene1-draft-run-mismatches-and-sheet-only.png`**, even though the SEED
   RESULT above proves `commitElectiveRun` computed them correctly. This is
   architectural, not a screenshot-tooling gap: that finding is response-only
   (never persisted — filtered out of `ELIGIBILITY_FINDING_KINDS`), so it only
   ever reaches `AssignmentPanel`'s own React state when ITS OWN call to
   `commitElectiveRun` resolves. My seeding script calls the mock function
   directly via `page.evaluate`, bypassing `AssignmentPanel`'s component
   entirely — so the finding is computed but never reaches any component's
   props. Reproducing the grouped-row screenshot would require performing an
   actual file-based import through `AssignmentPanel`'s own UI (its
   `input[type=file]` accepts `setInputFiles`, as T249's own `capture.mjs`
   demonstrates), with a sheet file in the real preference-sheet parser's
   exact expected format — not attempted here. The grouping/rendering logic
   itself is independently verified by 75 passing `DraftRunView` render tests
   in `src/screens/elective/run/ElectiveRunViews.test.jsx`, which exercise
   the real component, not a screenshot.

2. **`scene1`'s sheet-only-camper names read "a camper who is no longer on
   the roster" twice, not "Shir Cohen"/"Omer Levi".** `localClient.mock.js`'s
   `commitElectiveRun` does `state.campers = parsed.campers ?? []` — a full
   replace, not a merge — so seeding the later demo runs (Week 2, Week 0) in
   the same script overwrote Week 1's roster. This is a pre-existing mock
   limitation (state.campers was never cumulative across runs), unrelated to
   any of this task's seams. It does usefully re-confirm this round's M1 fix
   live: before M1 this row would have printed the raw camper ids
   (`cam-sheet1`/`cam-sheet2`); after M1 it degrades truthfully instead.
