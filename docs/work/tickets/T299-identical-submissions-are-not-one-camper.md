---
title: "Two campers who answered identically are two campers"
document_type: ticket
status: open
created: 2026-09-28
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md]
related_adrs: [docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md]
related_tickets: [docs/work/tickets/T285-preference-shape-adapters.md, docs/work/tickets/T298-residue-map-to-existing-and-packed-cell-decision.md]
archive_when: "two unattributed submissions carrying identical answers produce TWO camper subjects, not one; the same submission imported twice still converges to one; a director is told when submissions are indistinguishable by content so they can say whether it is one child or two; and a test drives the real import path twice with byte-identical content and asserts two rows in the database"
---

# T299 — Two campers who answered identically are two campers

## The defect, confirmed by execution 2026-09-28

`submissionKeyFromRows` in `src/ingest/preferenceImport.js` derives a provisional subject's identity
from **the row content alone**:

```js
const text = rows.map((row) => (row ?? []).map((c) => String(c ?? '')).join('\u0000')).join('\u0001')
```

Executed on two byte-identical row sets, it returns the same key. So two campers who filled out the
same activities — entirely plausible in a camp offering eight options where archery and swim are the
obvious picks — collapse into **one** camper subject holding both children's preferences.

This is the same "merge two real children" failure T285 was built to eliminate, reappearing through
the door T285 opened while fixing it. The filename key was replaced with a content key precisely
because two files named `planner.csv` were colliding; a content key collides whenever two children
agree.

## Why this is genuinely hard, and must not be "fixed" by guessing

The same evidence supports three different truths, and the app cannot tell them apart from content:

1. **Two children who happen to agree.** Legitimate and common with a short activity list.
2. **One child submitted twice.** A parent filling the form again, or a re-export of the same data.
3. **A copy-paste error in the source file.** One camper's row duplicated over another's.

Case 2 is the behaviour the content key exists to produce — the SAME submission re-imported must
converge to one subject, not accumulate duplicates. That requirement is real and must not be broken
while fixing case 1.

So this is not a keying bug to be solved by adding entropy. **Adding a counter or a timestamp would
fix case 1 and break case 2**, turning idempotent re-import into silent duplication — the same trade
`electron/ops/electiveDerivedIds.js` warns about when it says an ordinal trades a visible collision
for a silent fork.

## The shape of the answer

Per the standing rulings, the app does not decide this — it lands the data and asks. The director
knows whether that is one child or two; nothing in the file does.

- Both submissions must LAND. Never refuse, never drop the second.
- The two subjects must be distinguishable so a director can merge them if they are one child, per
  the attribution/rekey path T285 already built.
- Indistinguishable-by-content submissions belong in the attention surface alongside unattributed
  campers — the existing vocabulary, not a new one (owner ruling, 2026-09-28).
- Whatever distinguishes the second submission must not break re-import idempotence. Ordering within
  one import and arrival across imports are different facts; say which one is being used.

## Non-goals

- Not a general de-duplication engine. One question: are these two submissions one child or two.
- Not a merge UI beyond what attribution already provides.
- Not fuzzy matching. Two submissions that are *nearly* identical are out of scope; this is about
  byte-identical content.

## Notes for whoever takes this

- `deriveCamperId` (`electron/ops/electiveDerivedIds.js`) prefers an `externalId` when present, so a
  sheet that carries a camper id is unaffected. This defect is specific to the UNATTRIBUTED path —
  a grid with no name column, which per owner ruling is one camper's own sheet.
- The `sameNameCampers` refusal is the analogous guard on the named path and is NOT the model to copy
  here: refusing is wrong under the standing ruling that a readable file is never refused.
- Verify the claim before designing: run `submissionKeyFromRows` on two identical row sets yourself.

## What was built

A provisional subject is now keyed on **(submission, arrival)** rather than on the submission alone,
through a third `sub` mode in `deriveCamperId` (`electron/ops/electiveDerivedIds.js`). No schema
version was taken and no column moved — the identity is derived, not stored.

**The fact that separates the three truths is ARRIVAL ACROSS IMPORTS, not ordering within one
import.** Two children handing in matching sheets are two import actions; one import action repeated
is one arrival. Ordering within an import (a row ordinal, a sheet index) describes how the file
happened to be sorted rather than whose sheet it is, and re-sorting the file would re-key the child —
which is the trade `electiveDerivedIds.js` already warns about. The caller states its arrival,
because only the caller knows: `AssignmentPanel` mints one per file selection, and
`scripts/preferenceSheetCli.js` passes the run id it derives from the file's bytes, which is what
keeps an agent's retry after an ambiguous timeout idempotent.

`external_id` still holds the plain submission key, so two subjects that answered identically share
it, and `buildStructureIssues` (`src/ingest/attentionList.js`) tells the director on the existing
attention surface. Naming both subjects the same child merges them through T285's rekey; naming them
separately keeps them apart. The app takes no view on which.

**A second defect, found while verifying and fixed here.** `useCurrentStructureCounts`
(`src/hooks/useCurrentStructureCounts.js`) never loaded `campers`, so `buildStructureIssues`'s
unattributed-subject branch — T285's only reader of `campers.is_unattributed` — produced nothing in
the running app while passing its own unit tests, which hand it a collections object the hook never
produces. T285's promise ("name the camper when you know them") had no surface. Guarded now at the
choke point: `attentionList.test.js` builds its collections from the real load list.

## Known limit at close

Two limits, both confirmed by execution, and together they are why this stays open.

**1. The CLI/MCP path still merges two byte-identical files into one subject.** Not an oversight but
an unresolved product question. `deriveImportedElectiveRunId` keys a CLI import on the file's bytes
precisely so that re-sending the same bytes is an idempotent retry; under that declaration two
identical files ARE one submission arriving once, and there is no second fact on that path to
separate them. Giving the CLI a per-invocation arrival would split the two children and
simultaneously fork every retry. Pinned as a test rather than left implicit, in
`test/unattributedSubjectIdentity.test.js` ("KNOWN LIMIT"), so it cannot drift either way unnoticed.

Closing it needs an owner decision — most likely an explicit idempotency token supplied by the
caller, so a retry can say it is a retry instead of being inferred from content.

**2. A WHOLE-SHEET planner grid cannot be imported through the director's panel at all.** Pre-existing,
found while verifying this ticket, and it bounds the first `archive_when` clause more than the
CLI limit does. `MappingCorrector`'s confirm gate is
`mapping.nameIndex != null && rankColumns.length > 0`, and a child's own planner has neither by
design — the identity comes from the submission, and the cells ARE the ranks. So the button never
enables and the director cannot leave the mapping screen. The grid shape that DOES reach the panel is
a planner above a ranked block (the preamble-grid form), and that one exercises this ticket's fix
end to end.

The gap survived because `test/panelImportPath.test.js` calls `readPreferenceSheet` directly and
never renders the gate, so "the panel path" was tested without the panel. Pinned now at
`src/screens/elective/assignment/AssignmentPanel.test.jsx`. Left unfixed deliberately: what the
mapping screen should show for a sheet with no name column and no rank columns is a product question,
not a wiring one.
