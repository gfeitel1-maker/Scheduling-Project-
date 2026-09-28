---
title: "Residue resolution slice 2 — join a label to an activity that exists, and settle a packed cell"
document_type: ticket
status: completed
created: 2026-09-28
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md]
related_tickets: [docs/work/tickets/T285-preference-shape-adapters.md, docs/work/tickets/T280-import-decision-journal-for-axis-bindings.md]
archive_when: "Both resolutions land AT THE DATABASE from FILE BYTES, not as a change to a residue count. (1) MAP: a sheet whose label near-matches an existing activity has that activity PROPOSED and not applied; once the director confirms, all N rows naming the file's spelling attach to the activity that ALREADY EXISTS — no second `activities` row, exactly one `elective_choices` row, and its label is the CAMP's spelling so its labelKey matches the offering's — and this holds on BOTH the ranked-table and planner-grid paths. (2) PACKED: `AMBIGUOUS_PACKED_CELL` is in `DECISION_KINDS` with three implemented actions; resolved as several it produces those several choices at rank NULL and does not trip the same-rank refusal, resolved as one it produces exactly one. (3) NO DEAD AFFORDANCE: the mapping picker is ABSENT (not disabled, not empty) when the camp has no activities, and the split is absent on a row with no parts. (4) JOURNAL: every decision PRESENTED gets a row including UNANSWERED ones, and `chosen.action` distinguishes the three readings that all share the CHANGED outcome. (5) Every one of the above has its defect PLANTED and the red confirmed to land on the data. Solve Assignments remains available throughout."
---

# T298 — Residue resolution slice 2

Slice 1 (T285, PR #608) turned residue into decisions and acknowledgments and shipped
**one** action: add the named activity. It said in `ParseSummary.jsx` exactly what it was
leaving out and why:

> *"Map it to an existing activity is a real decision and is NOT here — it needs a picker
> and a proposal rule, and half of it rendered as a disabled affordance would look
> finished while doing nothing."*

This is the picker, the proposal rule, and the promotion of the one residue kind that had
three live readings and no way to choose among them.

## What this discharges

**1. Map to an existing activity.** A director whose sheet says "Arts and Crafts" while the
camp has "Arts & Crafts" does not want a second activity — they want the two joined. The row
now carries a picker over the camp's own activities with a likely match preselected, and one
press settles the whole label group: forty rows, one mapping.

The mechanism is the one slice 1 established — **settle, then re-parse** — with one addition
that is the whole point at the database: a mapped label is read as the **camp's** spelling
from that moment on. Without that substitution the preferences derive their own
`elective_choices` row under the file's spelling, match no offering, and the mapping joins
nothing while appearing to succeed.

**2. `AMBIGUOUS_PACKED_CELL` becomes a decision.** A cell reading "Swim, Archery, Ceramics"
has three readings and now three implemented actions: read it as those separate choices, add
it as one oddly-named activity, or map it to one the camp already spells differently. That is
what earns the promotion — the kind was correctly an acknowledgment while nothing could be
done about it.

**3. MCP/CLI parity.** `preference_sheet_preview` / `preference_sheet_commit` take a
`label_resolutions` array. An agent could already *see* the residue and could not *answer*
it. Deliberately limited to the two resolutions that write nothing: `map_to_existing` and
`split_packed` are statements about how to read a file, whereas `add_activity` mints a camp
activity, and a tool whose stated job is "read this sheet" must not change the camp's setup
as a side effect.

## Where the brief was overridden

The brief named `nearDuplicateNames.js` as the proposal tool, which is right — it is the only
module in `src/ingest/` whose bias is precision rather than recall, and its rejection of edit
distance stands. But its single rule is *stem plus grammatical suffix*, and that rule cannot
match the owner's own example: folded, "Arts and Crafts" and "Arts & Crafts" are
`artsandcrafts` and `arts&crafts`, neither a prefix of the other. So a **second rule** was
added to the same module, exported separately so the first's precision argument is not
quietly restated about a rule it was never made for.

The new rule is **equality, not distance**: everything but the connector must be
character-identical once case and whitespace are gone. It asserts only that "and", "&" and
"+" are three spellings of one connector — a fact about English, not a guess about two
names — which is why it is safe where edit distance is not. It still only ever proposes.

## The learning question, answered and deferred

**Should the delimiter choice be remembered per camp?** Eventually yes, and T118's
`compound_cell_decisions` is the right shape when the time comes. **Not in this slice**, by
owner ruling, and the reason is not just sequencing: T118's precedent earned its table by
being about a *pattern* (`Sports w/G1`) recurring across a file, whereas a packed cell is one
string. Whether camps consistently prefer splitting over naming, and whether a delimiter
choice generalises at all beyond the cell it was made about, is precisely what the journal
rows will show. Remembering now would be a guess wearing a table.

What ships instead is the evidence that ends the deferral honestly: every presented decision
is journalled, including the ones nobody touched, and `chosen.action` records **which** of
the three readings was taken — which the `outcome` column cannot, because all three are
`CHANGED`.

## Three findings worth keeping

- **A `g`-flagged regex used for both `replace` and `test` is stateful.** The connector rule's
  first draft shared one constant; `RegExp.prototype.test` advances `lastIndex`, so it
  abstained on every other call. No single-call test can see this, so there is one that calls
  it five times.
- **Split parts at rank 1 in a planner grid refuse the whole sheet.** Two names at rank 1 for
  one camper is what `describeElectiveRunRefusal` reads as a camper holding the same rank
  twice — so a resolved packed cell made the sheet unimportable. Parts take rank NULL on both
  paths now, which is ADR §4.1's own rule rather than a new one: the parts arrived in one
  cell, and cell order is not ordering evidence.
- **The planner-grid path was unguarded.** A real defect there — reading a mapped cell as the
  file's spelling — passed 78 tests, because every existing test entered through the ranked
  table. Both paths now have a test that cares about the answer.
