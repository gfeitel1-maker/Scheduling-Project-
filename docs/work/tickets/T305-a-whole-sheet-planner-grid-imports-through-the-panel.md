---
title: "A whole-sheet planner grid imports through the director's panel"
document_type: ticket
status: open
created: 2026-09-29
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md]
related_tickets: [docs/work/tickets/T299-identical-submissions-are-not-one-camper.md]
archive_when: "a sheet that is nothing but a day x period planner grid imports through the director's elective preference panel with no mapping screen and lands an unattributed subject carrying its per-cell preferences; a sheet with unmapped columns and NO detectable grid still stops at the mapping screen; and tests drive the RENDERED panel for both cases, replacing the T299 guard that asserted the Confirm button stays disabled"
---

# T305 — A whole-sheet planner grid imports through the director's panel

Found while building [T299](T299-identical-submissions-are-not-one-camper.md) (PR #618) and recorded
there as "Known limit at close" item 2. Confirmed by execution before this ticket was written.

## What a director hits

They drop a sheet that is nothing but their camper's filled-in day × period planner — the form the
child took home, filled in, and handed back. The panel shows the mapping screen, the **Confirm
Mapping** button never enables, and the screen tells them:

> "No rank columns were found. Ranks look like #1, #2, #3 in your header — add one below."

They cannot import the sheet. There is no way forward except **Choose a Different File**.

## The mechanism, confirmed by execution

`inferPreferenceLayout` on a real grid returns `nameIndex: null`, `rankColumns: []`,
`unmapped: ['name','ranks']`. `MappingCorrector`'s gate is:

```js
const canConfirm =
  mapping?.nameIndex != null && rankColumns.length > 0 && rankColumns.every((r) => r.index != null)
```

so `canConfirm` is structurally false and the button can never enable.
`src/screens/elective/assignment/AssignmentPanel.jsx` renders `MappingCorrector` unconditionally for
`phase === 'mapping'`; there is no grid bypass.

A planner has no name column and no rank columns **by design** — ADR §14.1a: the identity comes from
the *submission*, not the page, and the cells *are* the ranks. So the gate's advice is not merely
unhelpful, it is **wrong for this file**: a director who follows it manufactures a mapping that
misreads their sheet. The guard fires correctly and prescribes the wrong remedy.

The contrast case still works, which is what scopes this: a grid sitting **above** a ranked block
(probe `P23-grid-plus-ranked-fallback.csv`) returns `nameIndex: 0`, two rank columns, `unmapped: []`
— the ranked block supplies what the gate wants. The defect is specific to a sheet that is *nothing
but* a planner.

## This is a refusal, and §14.1a forbids it

The standing owner ruling in ADR §14.1a:

> "our job is not to question what shape the data comes in. we are a lake, the warehouse, and the
> pipeline."

and its ruling: **land the data and report the uncertainty — never refuse, never drop the unreadable
half.** A permanently disabled Confirm button is a refusal at the UI seam. §14.1a names this pattern
as having already recurred three times, and names the tell: *"reporting something instead of storing
it."* This is the fourth, in the UI layer — the transform was fixed, and the screen in front of it
still refuses.

## Why it survived

`test/panelImportPath.test.js` is named for the panel, but its `importThroughPanelPath` helper calls
`readPreferenceSheet` directly and never renders `MappingCorrector`. "The panel path" was tested
without the panel.

## What is already built, and must not be rebuilt

Verified before designing, because most of this ticket's apparent surface already exists:

- **The transform reads the grid correctly.** `readPreferenceSheet` in
  `src/ingest/preferenceImport.js` detects a whole-sheet grid and lands an unattributed subject with
  its per-cell preferences. The CLI (`scripts/preferenceSheetCli.js`) and the MCP tools reach it
  without difficulty.
- **`confirmMapping` already calls the transform correctly**, with catalog, grid and subject — and
  already has a correct fallback for a genuinely unreadable file: *"That file does not read as a
  camper preference sheet — no camper-name column and no day/period grid. Nothing was changed."*
- **The statement to the director already exists.** `parsePreferenceSheet` emits an
  `UNATTRIBUTED_SUBJECT` residue item — *"Stored as 'unnamed' / Not yet named — N period rows are
  saved against it"* — and `ParseSummary` renders residue generically, as an acknowledgment rather
  than a decision, which is the right register.

**An owner ruling governs where the ASK lives**, recorded in `src/ingest/preferenceSheet.js` beside
that residue item:

> "The ASK ('name the camper') deliberately lives on the attention surface
> (src/ingest/attentionList.js), which is navigable, not here, which is not. Owner ruling:
> unattributed campers live there. One statement, one place to act."

**So this ticket adds no naming control to the parse summary.** It states; the attention surface
asks. Making that ask answerable is T306, not this ticket.

**T304 is in flight in a sibling worktree** ("a staff session can see what the import left
unnamed"), making these attention rows visible to staff sessions. It is deliberately NOT in
`related_tickets` above: it is unpushed, so from this tree that path is a dangling reference and
`check:governance` is right to say so. Link it when it lands.

## Owner decisions, 2026-09-29

Two questions were put to the owner during this ticket's design.

1. **What should the app do with a whole-sheet planner?** Ruling: **land it and say what was read.**
   No mapping screen for a detected grid. Explicitly *not* a screen asking the director to declare
   planner-vs-offerings-menu: the entry point is already the declaration — a director inside an
   elective set's import panel has said "these are camper preferences" — and asking would be the
   shape-interrogation §14.1a exists to stop.

   This resolves a real tension with ADR §3.3, which says an offerings menu and a filled planner have
   "the same geometry and opposite meaning; only the declared kind separates them, and no amount of
   shape inference can." The ruling is that the **panel** carries the declaration. The residual risk
   — a director drops the camp's offerings menu here — produces one visible, deletable unattributed
   subject, not the merge of two real children that §14.1a names as the only legitimate refusal.

2. **How far does the work go?** Ruling: **T305 then T306, in sequence, both before stopping.**
   Landing the planner makes the app say a child is unnamed; T306 makes that answerable.

## The design

Two changes.

### 1. One predicate, not two

`readPreferenceSheet` derives the whole-sheet-grid verdict as
`mapping.unmapped.length > 0 ? detectGridLayout(rows, 0) : null`. If the panel re-derives the same
expression, the two drift the moment either changes — the defect class
`docs/work/tickets/T274-*.md` is about (guard the choke point, not the instance).

Export **one** `detectWholeSheetGrid(rows, mapping)` and have both `readPreferenceSheet` and the
panel call it. Note what this makes visible: the UI gate and the transform's grid path are exact
complements — the condition that disables the button is the condition that switches the transform
into grid mode. The panel has been asking a question the transform already answered.

### 2. Skip the screen, and pass the values explicitly

In `onFileSelected`, when the predicate returns a layout, call `confirmMapping()` instead of
`setPhase('mapping')`.

**The trap, which this file already documents one field over.** `confirmMapping` reads `rows`,
`sourceLabel`, `submissionKey` and `arrivalId` from React state, and none of those `setX` calls have
landed in the same tick. The three existing resolution paths hit exactly this and solved it by
passing values explicitly:

> "Passed explicitly by the three settle paths above because `setResolutions` has not landed in this
> render yet — reading state there would re-parse against the resolutions as they were BEFORE the
> director's press, which is the same stale-catalog trap `extraActivities` exists to avoid, one field
> over."

So `confirmMapping` takes those four explicitly on this path. Reading state instead would silently
re-parse an **empty** sheet on the first import — a green-looking no-op.

## What must remain true

- **A sheet that is genuinely unreadable still stops at the mapping screen.** Unmapped columns and no
  detectable grid is the case the gate legitimately exists for. Removing the gate outright is not the
  fix and must fail a test.
- **The preamble-grid form keeps working** — a grid above a ranked block still reaches the panel via
  the ordinary mapping path, unchanged.
- **`detectGridLayout` stays conservative.** It requires ≥2 day-named columns *and* ≥1 body row whose
  first cell reads as a period, returning `null` otherwise. Nothing here loosens it.
- **No naming control on the parse summary** (owner ruling above).

## Tests

Test-first; this is a bug-fix seam and a director-facing path.

1. **Replace** the T299 guard `AssignmentPanel.test.jsx` → *"leaves a whole-sheet planner stuck at the
   mapping gate (documented gap, not a fix)"*. It asserted the button stays disabled and must not be
   deleted silently — its replacement asserts the planner reaches `parsed` with **no mapping screen**.
2. **The negative case, which is the one that proves the gate was not simply removed.** A sheet with
   unmapped columns and no detectable grid must still render the mapping screen. Without this, a
   patch that deletes the gate passes every other test here.
3. The preamble-grid case still reaches the panel through the mapping screen.
4. The landed subject carries its per-cell preferences and is marked unattributed.
5. Drive the **rendered panel**, not `readPreferenceSheet` — the defect this closes is that a helper
   named for the panel never rendered it.
