---
title: T249 — visual evidence for the D8 at-rest-encryption gate
document_type: evidence
status: completed
created: 2026-09-24
governing_docs: [docs/governance/standards/DESIGN_STANDARD.md, SECURITY.md]
related_adrs: [docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md]
---

# T249 — what the director actually sees

Captured against the browser-dev renderer (`npx vite`) with the mock local client and
`window.__seedDemo()`. **Every name in these shots is fabricated** — "Demo Camp (sample)",
"Afternoon Chugim", "Fixture Camper One/Two". No real camp or camper data is involved, which
is the same rule the disclosure itself states.

`capture.mjs` is the exact reproduction script (Playwright). Re-run with a dev server on
`SHOT_URL` (default `http://localhost:5211/`). It prints its own assertions rather than only
writing images:

```
DISCLOSURE TEXT: "Camper data in this feature is not yet encrypted at rest. Do not use real camper names until this is enabled."
CONTROLS INSIDE THE ROW: 0
PHASE REACHED: mapping
MAPPING PHASE, DISCLOSURE STILL PRESENT: 1
MAPPING PHASE DISCLOSURE TEXT: "Camper data in this feature is not yet encrypted at rest. Do not use real camper names until this is enabled."
PAGE ERRORS: none
```

| File | What it shows |
|---|---|
| `01-entry-no-run-state.png` | The feature's entry point — `AssignmentPanel`'s "No run" state — with the disclosure above it. |
| `02-disclosure-row-closeup.png` | The row itself, bronze `S.cautionBanner` (DESIGN_STANDARD §4 caution role), no dismiss control. |
| `03-still-present-in-mapping-phase.png` | The same row still present after the director has imported a preference sheet and reached the column-mapping phase — the state a one-time-render bug would have dropped it in. |

## One thing that went wrong while capturing this, recorded because it is the interesting part

The first run of `capture.mjs` produced a plausible-looking `03-...png` that was **not evidence**.
This screen has two `input[type=file]` elements with byte-identical `accept` attributes: the
offerings importer's and `AssignmentPanel`'s. `page.setInputFiles('input[type=file]', …)` hit the
first one, so the screenshot showed the offerings importer's error message with the assignment
panel still sitting in its entry state — while the script cheerfully logged
"MAPPING PHASE, DISCLOSURE STILL PRESENT: 1", which was true and irrelevant. The script now
targets `.last()` and asserts the phase it claims to be in before it takes the picture.

## Note on the port

`5200` was already held by a dev server from a **different worktree** at a different commit, and
`strictPort` makes that collision silent for anyone who does not check. These shots were taken on
`5211`, and the served module was confirmed to contain this change before anything was captured:

```
$ curl -s http://localhost:5211/src/screens/elective/assignment/AssignmentPanel.jsx | grep -c "not yet encrypted at rest"
1
$ curl -s http://localhost:5200/src/screens/elective/assignment/AssignmentPanel.jsx | grep -c "not yet encrypted at rest"
0
```
