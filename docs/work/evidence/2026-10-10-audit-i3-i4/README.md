---
title: "Audit I3/I4 evidence: time-block labels and Roots counts (browser mock)"
document_type: evidence
status: active
created: 2026-10-10
archive_when: the schedule grid row header, the Fixed Events time column, or the Roots home bento changes
---
# Audit I3/I4 — before/after (browser mock)

Captured with headless Chrome over CDP (`Page.captureScreenshot`) against `npx vite --port 5223`,
driving the browser mock (`src/localClient.mock.js`). After `window.__seedDemo()` the mock state was
reshaped into an imported-camp shape: blocks named `09:00-09:45`, `11:30-12:15`, `12:55-01:35`,
`03:20-03:40` (stored 15:20–15:40) and `Swim Period`; three pinned-event activity rows
(`catalog_role: 'pinned_event'`); two `kind: 'fixed'` and three `kind: 'recurring'` fixed_events rows.
The `before-*` frames were captured on the unchanged branch tip (c4468600), the `after-*` frames on
the working tree with this change. Same seed, same script, both times.

| Frame | Before | After |
|---|---|---|
| `*-01-roots.png` | Activities 8 (5 + 3 pinned), Fixed Events 5 (2 fixed + 3 recurring), "Days & Blocks" 10 (5 + 5) | Activities 5, Fixed Events 2, Time Blocks 5 — each the row count of the screen it names |
| `*-02-fixed-events.png` | Time block column `03:20-03:40 (3:20–3:40 PM)` | `3:20–3:40 PM` |
| `*-03-schedule-grid.png` | Row header `12:55-01:35` over `12:55–13:35` (no AM/PM vs 24h) | `12:55–1:35 PM` once; a named block keeps a 12-hour time line (`Swim Period` / `4:00–4:45 PM`) |

`*-03-schedule-grid.txt` is the page's visible text at capture time.

Not shown: the Excel export day sheets and the special-day (replaced) lane use the same helper and
are covered by unit tests only.
