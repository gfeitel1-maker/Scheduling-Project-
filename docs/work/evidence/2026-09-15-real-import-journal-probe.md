---
title: "Running real imports produced NO journal data — because the importer asks nothing"
document_type: evidence
status: active
date: 2026-09-15
task_class: ingestion
related_tickets: []
related_specs: [docs/superpowers/specs/2026-09-15-seedlings-importer-learning-design.md]
archive_when: the owner has decided whether a typo'd re-import that duplicates an existing activity should ask, and the decision is recorded either way
---

# Real-import probe — the journal is empty, and the reason matters

The owner asked for a real import so seedling slices 2–4 could be designed on
journal evidence instead of on a guess. Eight real camp workbooks were driven
through the real ingest path. **Zero journal rows were produced, and zero would
have been produced through the UI either.** The reason is not a bug in the
journal.

## What was run

`~/Desktop/camp schedules/*.xlsx` (8 workbooks, real camp schedules) through
`extractEntities` → `inferFixedEvents` → `commitIngest` — the same functions
`ReconciliationScreen` drives — against throwaway camps. A representative file
(`Schedule by Group.xlsx`: 14 groups, 36 activities, 12 time blocks, 61 fixed
events) was committed for real, then re-imported.

## Result

| scenario | plan items | buckets | decisions |
|---|---|---|---|
| first import, empty camp | 68 (`create` 68) | understood 68 | **0** |
| same file re-imported | 68 (`unchanged` 68) | understood 68 | **0** |
| different file into populated camp | 68 (`unchanged` 38, `create` 30) | understood 68 | **0** |
| **typo'd re-import** (`Music`→`Musik`, `Drama`→`Drama Club`, `Water Play`→`Waterplay`) | 68 (`unchanged` 66, `create` 2) | understood 68 | **0** |

`needsAttention`, `notInSource` and `changed` are all 0 in every run;
`fieldProvenance` comes back with 0 entries. Run with the report builder fed the
real `fieldProvenance` and `evidenceSupport` the screen passes, not defaults.

## Why the journal stayed empty

`import_decisions` records what the importer **asked**. Nothing was asked, so
nothing was recorded. The journal is working exactly as specified.

Two facts underneath that:

1. **`recordImportDecisions` is reachable only from the renderer.** It is called
   at `ReconciliationScreen.jsx:218`, over the `shoresh:record-import-decisions`
   IPC. The headless CLI (`scripts/ingest.js --commit`) never writes a journal
   row — confirmed by committing a real import and reading `import_decisions`:
   36 activities and 14 groups landed, 0 journal rows. That is by design, not a
   gap: the journal records what was PRESENTED to a director, and the CLI
   presents nothing to anyone.
2. **The reconciler classifies this corpus as entirely understood**, so even the
   UI would have shown an empty triage screen.

## The finding that should redirect slices 2–4

A **typo'd re-import silently creates a duplicate and asks nothing.** Renaming
`Music` to `Musik` in 27 cells produces a `create` for `Musik`, leaves `Music`
in place, and raises no decision. The camp now has two activities where it had
one, and the director was never consulted.

The seedling premise was *"stop needing a human for obvious cases."* On real
files the human is never asked in the first place. The gap is the opposite
shape: the app is already deciding silently, and the case where it decides
WRONGLY (a duplicate catalog entry) is indistinguishable, from the director's
side, from the case where it decides rightly.

This is consistent with slice 2's premise having already been checked and found
mostly wrong (`HIGH_IDENTITY_TIERS` returns `outcome: 'understood', decision:
null` for an exact name match — the importer already looks before it asks).
Learning from decisions cannot be the mechanism when there are no decisions.

## What this probe does NOT establish

Stated plainly, because a clean negative is easy to over-read — and three
separate measurements in this probe were wrong before they were right (activity
entities are plain STRINGS, not objects; reading `a.name` compared `undefined`
to `undefined` and reported "canonicalized away" for every rename;
`buildReconciliationReport` takes `{planItems, readiness, ...}` and silently
defaults `planItems` to `[]` when handed the wrong shape).

Not exercised, and each can still raise decisions:

- **held conflicts** (`heldConflictsToDecisions`) — needs a peer race or a
  genuine validation/eligibility hold; `held` was false throughout.
- **ambiguous identity against existing aliases** — needs a camp with alias
  history, which a throwaway camp does not have.
- **unresolved locations**, **elective header findings**, **multi-block events**.
- **`activityRules`** — the UI can pass inferred rules; this probe did not.

A camp with real history, or a file that genuinely confuses the parser, may
still produce decisions. The claim here is narrower and solid: **these eight
real files, through the real path, ask nothing.**

## Recommendation

Do not build slices 2–4 on journal evidence yet — there is none, and forcing
some by synthesising confusing files would be designing against fiction. The
honest next question is a product one for the owner: *should a typo'd re-import
that duplicates an existing activity ask?* If yes, that is a reconciler change
that CREATES the decisions the journal would then have something to learn from.
