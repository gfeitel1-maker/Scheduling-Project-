---
title: "Shape is not a reason to refuse ingest — thirteen preference-shape adapters into the ETL spine"
document_type: ticket
status: open
created: 2026-09-27
task_class: database-sync
archive_when: "PER-SLICE, because this is a program and one predicate over thirteen probes would be dischargeable only by finishing all of it: SLICE A (header/identity) — P03, P04, P34, P12 and P11 each COMMIT with the right data asserted at the database (prose rank headers read as ranks; a bare `Student` header read as the name; `First Name`/`Last Name` joined into one display name; a header that is not row 1 located; two `#1` columns read as an UNORDERED SET per ADR 4.1 rather than refused), and the ADR 14.1 violation count falls from 14 to 9. SLICE B (compound headers) — P29 and P30 COMMIT with each preference carrying the coordinate the header names, count falls to 7. SLICE C (tidy/inverted) — P31 and P32 COMMIT with one row per (camper, rank, activity), count falls to 5. SLICE D (multi-sheet) — P26 COMMITs and the reader stops being first-sheet-only without merging two submissions into one run, count falls to 4. SLICE E (menu) — P22 is READ without refusing AND correctly concludes it names NO camper preferences: zero campers and zero elective_preferences rows written, with residue naming it a menu, count falls to 3. SLICE F (grids) — P19 then P23 COMMIT, P23 reading BOTH its grid and its ranked block with the alternative reading named in residue, count falls to 1 (P07 alone, a genuine ambiguity that must stay refused; P39 is an empty file and writes nothing). Every slice: tests enter at FILE BYTES and assert at the DATABASE, no hand-built `parsed` object, and the silent-miss count against the seven measured misses is reported each round and is zero or explained."
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md]
related_tickets: [docs/work/tickets/T278-import-agnostic-elective-preferences.md, docs/work/tickets/T279-preference-etl-canonical-record-and-residue.md]
---

# T285 — Shape is not a reason to refuse ingest

Umbrella: **T278**. Design: ADR §14.1 (the standing rule), §11.1 (the elective adapter),
§12.0 (the RESOLVE rule every adapter inherits), §12.5 residual 3.

## The governing sentence

Owner, 2026-09-27, on the 14 refusals T279 measured:

> *"do the adapters. none of those read to me as things that should block ingest before etl to a way
> the system can parse."*

That is stronger than "support more formats." **Shape is not a reason to refuse ingest.** A refusal
belongs *after* ETL, if anywhere, and only for something genuinely unresolvable. Today's preference
reader refuses at the **header** — `inferPreferenceMapping`'s `unmapped` check in
`scripts/preferenceSheetCli.js`, before any transform has run, which is the wrong side of the
pipeline entirely.

This discharges the gap list T279 round 2 recorded against its own standing rule (ADR §14.1): **14 of
15 preference-path refusals violate it.** Drive that number to **0** and report it every round.

## Why this is not a licence to ingest anything

Three constraints that do not move, and the first is the one that gets this ticket into trouble if
it is forgotten.

1. **"Format-agnostic" must not become "kind-agnostic."** P22 is an **offerings menu** — a day ×
   period grid of *what is offered* — not preferences. Adapting it means READING it without refusing
   and then **correctly concluding it names no camper preferences**. It does NOT mean committing its
   activity names as camper choices. `src/ingest/scheduleShape.js:1-45` records the T224 incident: a
   camper selection workbook committed its column headers `#1`, `#2`, `Division` as 33 camp groups
   and again as 33 tiers. An adapter that ingests a menu as preferences reproduces that incident with
   better manners. **The owner's ruling removes the refusal; it does not remove the distinction**, and
   only the declared kind can separate a menu from a filled planner — the two have identical geometry
   and opposite meaning (ADR §3.3).
2. **Ambiguity resolves to residue or a director question, never to a silent guess.** A file readable
   two ways is read one way **loudly**, with the alternative named. P23 is the live case: a planner
   grid and a "Next Five Choices" ranked block on one page could legitimately be read as either
   alone.
3. **Every adapter is a new path into the ETL spine, so ADR §12.0 governs it**: never write a value
   you could not resolve without saying so. An adapter that makes a shape readable and then writes
   unresolved values is a regression dressed as a feature.

## The thirteen, and the two that stay

`test/fixtures/preference-corpus/manifest.json`. Sliced cheapest-first so the count moves early.

### Slice A — header and identity resolution (5 probes)
Nearly free given T279's resolvers; do these first.

| Probe | Shape | Note |
|---|---|---|
| P03 | prose rank headers (`First Choice`, `Second Choice`, …) | ADR §4.2 already records that `/^#\s*(\d+)$/` "matches essentially nothing" against real vendor exports |
| P04 | name column headed `Student`, not `Student Name` | |
| P34 | name split across `First Name` / `Last Name` | **the default output of most form tools — arguably the highest-value single fix in the list** |
| P12 | two title/junk rows above the real header | locating the header row, not a new shape |
| P11 | header lists rank `#1` twice | **a correctness fix, not a new shape** — resolvable as an UNORDERED SET (ADR §4.1), currently refused |

### Slice B — compound and per-period headers (2 probes)
| P29 | `Monday Period 3 - First Choice` compound headers, one row per camper |
| P30 | per-period hash ranks: `Monday #1`, `Monday #2`, `Wednesday #1` |

Both must land a **coordinate** per preference, which v79's `coordinate_day_label` /
`coordinate_period_label` now store (T279 round 2).

### Slice C — normalised exports (2 probes)
| P31 | tidy/long: one row per (camper, rank, activity) — what a normalised form backend emits |
| P32 | inverted matrix: one column per ACTIVITY, the cell holds the rank number |

### Slice D — the workbook reader (1 probe)
| P26 | mixed workbook. `readRows` in `scripts/preferenceSheetCli.js` is **FIRST SHEET ONLY** by a deliberate decision recorded there ("silently concatenating tabs would merge two different submissions into one run"). Fixing that is part of this slice, and the recorded hazard must be answered rather than ignored — per-sheet declared kind, not concatenation. |

### Slice E — the menu (1 probe)
| P22 | Kind 1 offerings menu. Success = **read, not refused, and zero campers and zero preferences written**, with residue naming it a menu. See constraint 1. |

### Slice F — the grids (2 probes), P23 last
| P19 | Kind 2 planner grid, periods in rows / days in columns, through the PREFERENCE reader |
| P23 | planner grid **plus** a "Next Five Choices" ranked block on ONE page (ADR class C). **The owner's own sheet, and the single most representative file in the corpus** — both preference models in one document. Subsumes P19, so it goes last. |

### Not adapted, deliberately
- **P07** stays a **refusal**. Two rows naming one child with no external id: guessing merges two real
  children, and there is no evidence for either reading. ADR §14.1's second category — *"this file is
  ambiguous and I cannot choose for you"* — which the never-refuse rule explicitly preserves.
- **P39** is an empty file. Nothing to accept; the message is a description, not a refusal of content.

## Acceptance discipline

- **Test-first, entering at FILE BYTES, asserting at the DATABASE.** No hand-built `parsed` object.
  This repo has three recorded instances in one day of tests that asserted on their own fixture
  (T62, T197 round 1, the v78 fallback row).
- **A bucket change is not evidence on its own.** A probe moving `BREAKS LOUDLY` → `COMMITTED` must
  carry an assertion that the **right** data landed. **A probe that commits wrong data is worse than
  one that refuses**, because the refusal at least tells the truth.
- **Report the silent-miss count every round.** It is **0** against the seven measured misses
  (ADR §8.1(c)) as of T279. Adapters are the change most likely to raise it: a newly-readable shape
  is a new opportunity to read it wrongly. **A rise is the expected cost of progress and must be
  reported, not absorbed.**
- Measure with `node scripts/preferenceCorpusProbe.mjs --seed-catalog`, and report the §14.1
  violation count alongside.

## Not in this ticket

The learning layer (T280–T282) — no remembered binding, no import profile, no drift detection. The
declared-kind UI surface (ADR §3.3 rulings 1–4) insofar as it needs a screen; this ticket may consume
a declared kind but does not design its confirmation surface.
