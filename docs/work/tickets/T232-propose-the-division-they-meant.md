---
title: T232-propose-the-division-they-meant
document_type: ticket
status: completed
created: 2026-09-18
archive_when: an unmatched division is reported by value with a proposed match, pinned by tests
governing_docs: [docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-17-individual-elective-scheduling.md]
related_tickets: [docs/work/tickets/T229-elective-assignment-in-set-detail.md, docs/work/tickets/T144-word-form-name-variants-never-reach-a-director.md]
---

# T232 — name the unmatched division, and propose the one they meant

## Owner challenge, 2026-09-18

> "why the hell would that produce no campers? we already do a fuzzy name matching throughout the
> ingest parts."

The challenge was right, and checking it corrected two things.

**First, my claim was wrong.** An unmatched division does NOT produce zero campers.
`buildAttendance` already treats an unmatched camper as eligible for every occurrence (never
unplaced) and surfaced a count. Verified: a camper listed as `Bogrimm` was placed in both divisions'
periods, three assignments, no silence.

**Second, the underlying point stands.** The report was a COUNT — "3 camper(s) had no division
matching a division on this schedule" — which tells a director that something is wrong and nothing
about what to fix. They are left to find three rows in a hundred-row spreadsheet they may not have
authored.

## Why the existing fuzzy matcher does not cover it

`src/ingest/nearDuplicateNames.js` is strictly SUFFIX-based ("Swim Return" → "Swim Returning"), so
`Bogrim` + `m` does not match: `m` is not a grammatical ending. It is narrow **on purpose** (T144) —
it runs against a camp's whole ACTIVITY vocabulary, an open set of dozens of names, where a loose
rule would ask a director about two things that were never related.

## Why a different rule is justified here, and only here

A division is the opposite shape: **the candidate set is closed and tiny.** A camp has three or four
tiers, authored in the app rather than typed on the sheet. Against three candidates a one-or-two
character edit is overwhelmingly a typo, not a coincidence — so an edit-distance rule is high
precision here and would be reckless against activities. `suggestDivisionMatch` is deliberately not
generalised and not offered to other callers.

Details that carry weight:

- **Damerau-Levenshtein, not plain Levenshtein.** A transposition (`Tzeirim` → `Tzierim`) is one of
  the commonest typing mistakes and is genuinely ONE error, but plain Levenshtein scores it as two,
  which pushes it outside a one-edit budget on a seven-character name. This is what lets the budget
  stay tight and still catch the typo a director will actually make.
- **The budget scales with length** (0 under 5 chars, 1 under 8, else 2), so `Bog` cannot reach
  `Bogrim`.
- **A tie is not a proposal.** When two divisions are equally near, nothing is proposed — asking "did
  you mean A or B?" about a value resembling both is the question T144 exists to avoid.

## PROPOSE, NEVER MERGE

Nothing acts on the suggestion. No camper's division changes, no attendance changes, and the
never-unplaced fallback is untouched — an unmatched camper is still considered for every occurrence.
This slice makes the problem legible; it does not change who gets placed.

## What the director sees now

Before: `3 camper(s) had no division matching a division on this schedule.`

After, one finding per distinct value: `2 camper(s) list the division "Bogrimm", which is not a
division on this schedule — did you mean "Bogrim"? They were considered for every occurrence.`
