---
title: T144-word-form-name-variants-never-reach-a-director
document_type: ticket
status: completed
created: 2026-09-11
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
archive_when: a director can merge "Swim Returning" onto "Swim Return" during import review, and the merge heals the catalogue, fixed events and multi-block candidates together
---

# T144 — A word-form typo mints a second activity and nobody is ever told

**Raised:** 2026-09-11, from T142's disproved premise.

## Two typo classes, one handled

`extractEntities` folds **whitespace/case** variants before any name becomes an
entity — `Lunch2` → `Lunch 2`, measured working on the owner's real file. That
fold is deliberately conservative and explicitly does NOT merge **word-form**
variants (`preview.js`: *"It does NOT merge word-form differences ('Swim
Return' vs 'Swim Returning')"*), because no safe deterministic rule can: `Lunch
1` and `Lunch 2` differ by as little, and a wrong merge malforms generation.

That is the right call. The defect is what happens next: **nothing.** The
variant silently becomes a second catalogue activity and no product surface
ever asks a human about it.

Measured on real files:

| File | Variants that survive |
|---|---|
| Schedule by Group.xlsx | `Swim Return` (17) · `Swim Returning` (1) |
| Shoresh-Campus-Map-Template.xlsx | `classroom` · `Classrooms` |
| campA | `Project` · `Projects` |

`scripts/ingest-sweep.mjs` already detects these with a high-precision
stem+suffix rule and prints them — but that is a read-only developer harness.
`rootsChips.js:8` names the case exactly (*"a near-duplicate for a human to
judge, not a match for this to quietly merge"*) and then judges nothing.
Near-duplicate gating exists in the product for **Locations only**
(`locationDuplicates.js`, `LocationsScreen`); activities have no equivalent.

## Consequences beyond a stray catalogue row

The variant drops evidence out of every downstream inference, because all of
them read through `canonicalMap`:

- **T143's companion pairing.** The Wednesday `Swim + Swim Return` candidate
  covers 7 groups instead of 8 — Alufim 2 is excluded purely because its
  Wednesday cell reads `Swim Returning`.
- **Fixed-event footprints.** A variant occurrence does not count toward the
  real event's day/group coverage, weakening confidence or dropping it below a
  threshold.
- **Frequency rules.** `Swim Returning` gets its own `min_per_week`.

## The fix

Promote the sweep's detector into the product as a director decision, and fold
the confirmed answer into the ONE seam every consumer already reads:

1. **Detector** — a pure module over (name, occurrence count). One name is
   exactly the other plus a grammatical suffix, compared whitespace- and
   case-insensitively. Propose the more frequent spelling as canonical, ties to
   the shorter stem. High precision on purpose: numbered siblings (`Lunch 1` /
   `Lunch 2`) and unrelated names must never be offered.
2. **Seam** — `buildActivityNameCanonicalMap` takes confirmed merges as extra
   aliases, so `extractEntities` produces one healed `canonicalMap` and the
   catalogue, `inferFixedEvents` and `inferMultiBlockCandidates` all see one
   name without any of them changing.
3. **Surface** — a card per candidate in import review, mirroring the
   compound-cell decision pattern (T118 slice 4): unresolved contributes
   nothing, resolved triggers the existing re-parse.

Persisting a confirmed merge across re-imports (mirroring
`listCompoundCellDecisions`) is a follow-up slice, not this one.
