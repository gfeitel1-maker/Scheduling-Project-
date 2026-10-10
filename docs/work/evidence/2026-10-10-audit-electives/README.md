---
title: "Elective audit E1-E7 before/after (browser mock)"
document_type: evidence
status: active
created: 2026-10-10
archive_when: the elective set screen, preference import, assignment preview or Manual Build rail changes again
---
# Elective audit E1-E7: before/after (browser mock)

These screens were captured with headless Chrome over CDP (port 9341) against `npx vite --port 5213`. Data
came from the browser mock (`src/localClient.mock.js`, `window.__seedDemo()`). The import file is the
fixture `docs/work/specs/samples/fabricated-camper-preferences-100.csv`, set on the file input with
`DOM.setFileInputFiles`. Before shots are from `origin/main` 38a78b24. After shots are from this branch.

| Item | Before | After |
|---|---|---|
| E1 offerings Import given a preference CSV | `E1-before-offerings-import.png` (bare "Couldn't read that file.") | `E1-after-offerings-import.png` (one line plus "Import as Camper Preferences"), `E1-after-routed-to-mapping.png` (one click later, the mapping step with every field pre-selected) |
| E2 mapping | `E2-before-mapping.png` | `E2-after-mapping.png` |
| E3 Manual Build rail | `E3-before-rail.png` (sets below activities) | `E3-after-rail.png` (sets at the top) |
| E4 "Open to" inferred | none, because the mock has no import evidence | `E4-after-open-to-dot.png`. The mock's `listImportEvidence` was overridden in the page to report Archery's eligibility as import-inferred. The rest of the page is unchanged. |
| E5 Not requested reason | `E5-before-solve-preview.png` | `E5-after-solve-preview.png` (summary line), `E5-after-chip-choices-full.png` (per-camper chips: "none of their choices is offered here" and "their choices were full") |
| E6 ranked choices not offered | `E6-before-parse-summary.png` | `E6-after-parse-summary.png` ("948 ranked choices were for activities not offered in this set.") |
| E7 saved run label | `E7-before-saved-runs.png` ("100 sheets · DRAFT") | `E7-after-saved-runs.png` ("100 campers · COMMITTED") |

Note on E2: in the mock, `E2-before-mapping.png` already shows all 13 fields pre-selected on main. The
owner's "Not mapped everywhere" did not reproduce from this code. The header variants it did not read
(`Rank 1`, `rank_1`, `Preference 1`, `CAMPER_ID`, `Full Name`, `Cabin` and others) are now read. They are
pinned in `src/ingest/preferenceHeaderVariants.test.js`.

Note on E7: the first run listed in `E1-after-offerings-import.png` still reads "100 sheets". That name
was stored before this change. Run names are written once, when the run is created, and are not renamed
afterwards.

Note on E5: the Not-requested reasons are preview-only by decision. "The preview is where the director
decides; not persisted — board keeper ruling 2026-10-10."
