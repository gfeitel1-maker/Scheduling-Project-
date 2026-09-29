---
title: "A director's column correction is honoured by the import"
document_type: ticket
status: completed
created: 2026-09-29
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_adrs: [docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md]
related_tickets: [docs/work/tickets/T305-a-whole-sheet-planner-grid-imports-through-the-panel.md, docs/work/tickets/T299-identical-submissions-are-not-one-camper.md]
archive_when: "a director who changes the camper-name column, adds a rank column, or remaps a rank in the elective preference panel's mapping corrector gets an import that reflects the CHANGED mapping; a sheet whose headers the inferencer does not recognise imports once the director maps its columns by hand; an overridden mapping cannot describe a column as unread when the director just mapped it, and cannot read one column twice; and tests drive the RENDERED corrector for all of these rather than calling readPreferenceSheet directly"
---

# T307 — A director's column correction is honoured by the import

Found while reading the panel's import path at `5155fc33`. Confirmed by execution before this ticket
was written. Stacked on [T305](T305-a-whole-sheet-planner-grid-imports-through-the-panel.md) (PR #620),
which changes `confirmMapping`'s signature in the same file.

## What a director hits

They drop a preference sheet whose columns are named the way their camp names them — `Pick A` /
`Pick B`, or `Top` / `Alternate`, or `Period 1 Pick` / `Period 2 Pick`. The mapping screen opens and
tells them:

> "No rank columns were found. Ranks look like #1, #2, #3 in your header — add one below."

They do exactly that. They add rank #1, point it at `Pick A`, add rank #2, point it at `Pick B`.
**Confirm Mapping lights up.** They press it, and the panel answers:

> "That file does not read as a camper preference sheet — no camper-name column and no day/period
> grid. Nothing was changed."

There is no way forward except **Choose a Different File**. The screen asked them a question, accepted
their answer, unlocked the button on the strength of it, and then told them the file was unreadable.

The quieter half is worse, because nothing marks it. On a sheet the inferencer *does* read, but not
the way this camp meant — a roster carrying both `Camper` (the legal name) and `Goes By` (what the
camp actually calls them), where the inferencer takes `Camper`, correctly on the evidence it has —
the director remaps it, Confirm works, the preview appears, and the import lands the **original**
reading. Their correction changed nothing and said nothing.

## The mechanism, confirmed by execution

`AssignmentPanel.jsx` holds `mapping` state and hands `onChange={setMapping}` to `MappingCorrector`,
so the director's edits do update state. Every non-comment read of that state is inside the
`<MappingCorrector>` JSX — the `header`, `sampleRows` and `mapping` props. It reaches the import
nowhere.

`confirmMapping` calls `readPreferenceSheet({ rows, campId, catalog, sourceLabel, submissionKey,
arrivalId, resolutions })`. There is no `mapping` parameter to pass it to. Internally
`readPreferenceSheet` always re-derives the mapping with `inferPreferenceLayout(rows, { catalog })`.

**The state is not inert, which is what turns a no-op into a dead end.** `MappingCorrector`'s
`canConfirm` reads the edited mapping. So a correction has exactly one effect — it enables the button
— and the import behind that button re-derives, finds the same `unmapped` it found before, and
returns `parsed: null`.

Measured, with the real reader, catalog `['Archery','Ceramics']`:

| Header row | Inferred | Corrector enables Confirm | Import writes |
|---|---|---|---|
| `Camper, Bunk, Pick A, Pick B` | `unmapped: ['ranks']` | yes | nothing |
| `Camper, Top, Alternate` | `unmapped: ['ranks']` | yes | nothing |
| `Camper, Period 1 Pick, Period 2 Pick` | `unmapped: ['ranks']` | yes | nothing |
| `Who, Bunk, #1, #2` | `unmapped: ['name']` | yes | nothing |

## How it got there

The comment at `confirmMapping` records it. The call used to be `parsePreferenceSheet(rows, { campId,
mapping })`, which **did** pass the director's mapping. It was changed to the `readPreferenceSheet`
shape to fix a real and separate defect — no catalog, no grid, no subject, so the header locator never
ran and every resolver abstained. That fix was correct and must not be reverted; the catalog, grid and
subject arguments stay. It dropped the mapping parameter on the way past.

**The M2 affordance is its own regression.** `+ Add Rank Column` exists because a sheet with no
`#1`-style headers inferred zero rank columns, rendered no pickers, and could never enable Confirm —
a dead end. The dropped parameter did not restore the dead end; it moved it one step later, behind a
button that now lights up first.

## Why the existing guard could not see it

`test/panelImportPath.test.js` exists precisely to stop this class of defect. Its header states the
rule: *"a second set of ARGUMENTS is a second T224 even when the transform underneath is shared."*
It still missed this, and the reason is worth keeping.

That file calls `readPreferenceSheet` itself, with an argument object it writes out by hand. It never
renders the corrector, so it cannot observe what the panel actually passes. The panel's argument list
and the test's argument list were free to drift apart — and they did, in the one field the corrector
produces. **A test that asserts the shared call shape by re-writing the call is asserting about
itself.** The new coverage drives the rendered panel and reads the commit payload, so the arguments
under test are the ones the director's press produces.

## The decision, and why it is not the other one

Owner ruling, 2026-09-29, asked before implementation: **honour the mapping.**

The alternative considered was making the corrector read-only, on the argument in ADR §11.2 that axis
binding is a matching problem against known entities rather than an inference problem needing
confirmation. **That argument does not reach this screen.** §11.2 is about day/period axes: those are
matching problems precisely because the camp's days, time blocks and elective cells are entities the
projection already holds. The arrangement of columns in a stranger's spreadsheet is not a known set —
there is nothing to match a column position against. A read-only corrector would also make the four
header shapes above permanently un-importable through the panel, and
[T305](T305-a-whole-sheet-planner-grid-imports-through-the-panel.md) explicitly leaves them there
(*"a sheet with unmapped columns and NO detectable grid still stops at the mapping screen"*).

A third end state — teach the reader, so `Pick A` becomes a remembered rank header for that camp,
in the shape T298 gave label resolutions — remains the right long-term direction and is **not** closed
by this ticket. It is a larger piece of work, and the dead end stays live until it ships.

## Design

`readPreferenceSheet` gains **one optional parameter**, `mapping`. Absent, it re-derives exactly as
today — so the CLI and the MCP tools are untouched and there is still one call shape, which is what
ADR §3.2 asks for. Present, it is the mapping, because a director's answer is not evidence to be
weighed against the inferencer; it is the answer. This is the same precedence T298 gives a settled
label resolution, one layer up.

**The load-bearing constraint: an overridden mapping must be one the inferencer could itself have
produced.** The corrector edits role assignments (`nameIndex`, `externalIdIndex`, `divisionIndex`,
`rankColumns`) but leaves the *derived* halves of the object as the inferencer left them, and
`parsePreferenceSheet` reads those derived halves. Passing an edited object through raw produces two
false statements:

- **A column described as unread that the director just mapped.** `unrecognisedColumns` is computed
  from what the inference claimed. Remapping rank #1 onto a column the inferencer did not recognise
  leaves that column in `unrecognisedColumns`, and it is emitted as residue — a finding that says a
  column was not read, about a column that was.
- **One column read twice.** `parsePreferenceSheet` is **additive** across shapes: `rankColumns`,
  `longFormat`, `invertedMatrix`, `tiedColumns` and `unorderedSetIndex` each push cells, with no
  precedence between them. `inferPreferenceMapping` keeps them apart by gating — `invertedMatrix` is
  only proposed when no ordinary rank columns were found. A director who adds a rank column to a
  sheet the inferencer read as an inverted matrix defeats that gate, and every camper's row is read
  twice.

So the override is **normalised** against the same rules the inferencer applies to itself before it is
used: derived fields recomputed from the role assignments, and the shape gates re-applied. That is one
function next to `inferPreferenceMapping`, which is where the rules already live.

**The confirm gate asks the transform rather than restating it.** `MappingCorrector` carried its own
copy of "what counts as readable" — `nameIndex != null && rankColumns.length > 0` — and a copy is what
drifts. T305 found that clause refusing exactly the planner grids the transform could read. The first
draft of this ticket rebuilt the same fault one shape over: an **inverted matrix** carries its ranks
in its cells and so has no rank columns to count, which made a director add a dummy rank column to get
past the button — harmless while the mapping was discarded, and destructive the moment it is honoured,
because supplying rank columns is precisely what closes the inverted-matrix gate. So the gate is one
exported function beside the rules (`describeMappingReadiness`), and it asks `unmapped`, which is the
transform's own readability test.

It also reports the one failure the transform cannot state, because inference cannot produce it:
**a column carrying two roles** — two ranks on one column, or a rank on the camper-name column.
`parsePreferenceSheet` would read that column twice rather than refuse it. It is a half-finished edit
rather than a bad file, so it is caught in the corrector while the sample rows are still on screen,
**and the reason is rendered** — M2's finding was a director facing a control that would not enable
and no sentence saying what to change.

That last point constrains which collisions may be reported at all. **Inference can double-assign a
column by itself**: each role is located by its own independent `findIndex`, so a header like
`Child's Bunk Name` satisfies both the name and the division pattern. Refusing every collision would
therefore hand a director a disabled button naming two roles they have no control for — the terminal
state M2 forbids, reintroduced by the guard meant to prevent a different one. So a collision is
reported only when **at least one of its roles is one the corrector can move**, which makes the
message always name something the director can act on.

## Success predicate

Observable, in the rendered panel:

1. A director changes the camper-name column on a sheet that already read, confirms, and the imported
   campers carry names from the **changed** column.
2. A director maps the columns of a `Pick A` / `Pick B` sheet by hand, confirms, and the preferences
   land — no *"does not read as a camper preference sheet"*.
3. A director remaps a rank onto a previously unrecognised column, and the findings do **not** claim
   that column went unread.
4. A sheet the inferencer read as an inverted matrix, with a rank column added by hand, does not
   produce two preferences per camper per column.
5. A sheet the inferencer reads as an **inverted matrix** confirms as it stands, without the director
   having to invent a rank column to enable the button.
6. `readPreferenceSheet` called with no `mapping` behaves exactly as before — the machine path is
   unchanged.

## Non-goals

- **Not** reverting the catalog/grid/subject arguments. That fix stands.
- **Not** broadening the header recognisers. A sheet the inferencer misses is now importable by hand;
  teaching it to recognise `Pick A` is the remembered-binding work above, not this.
- **Not** remembering the correction across imports. This ticket makes one import obey one correction.
- **Not** touching the whole-sheet planner grid path, which is T305's.
- **Not** giving the machine path a mapping override. `scripts/preferenceSheetCli.js` — which is what
  the MCP tools reach through `runPreferenceSheetCli` — has its own read path calling
  `inferPreferenceLayout` and `parsePreferenceSheet` directly, and does not go through
  `readPreferenceSheet` at all. So it is untouched by this change rather than deliberately excluded
  from it. An agent that knows a layout and wants to state it is a reasonable next ticket; it is not
  this one, and it would want the same normalisation rather than a second copy of it.

## What shipped

Merged in PR #624 (`743448f5`), CI green.

- `readPreferenceSheet` takes an optional `mapping`. Absent, it locates the layout exactly as before.
  `scripts/preferenceSheetCli.js` — the path the MCP tools reach through `runPreferenceSheetCli` —
  does not call `readPreferenceSheet` at all, so the machine path is untouched rather than
  deliberately excluded.
- `mappingWithDirectorOverride` normalises a hand-edited mapping into one the inferencer could have
  produced: derived fields recomputed from the roles, shape gates re-applied.
- `describeCoverage` extracted, so inference and override share one definition of what a set of roles
  covers instead of two that drift.
- `describeMappingReadiness` replaces the confirm gate's private copy of "what counts as readable"
  with the transform's own `unmapped`, and reports a column carrying two roles.
- `MappingCorrector` stops hand-patching `unmapped` in its own mutators — the same stale-derived-field
  defect this ticket fixes downstream, one layer up.

**Two corrections made during implementation, both to this ticket's own first design.** Recorded
because each would have shipped a new defect while fixing the stated one:

1. The first gate kept `rankColumns.length > 0`. An **inverted matrix** carries its ranks in its cells
   and has no rank columns, so a director could only pass that gate by adding a dummy rank — which is
   precisely the edit that closes the inverted-matrix gate. Harmless while the mapping was discarded;
   destructive the moment it is honoured. This is why the gate asks `unmapped` rather than restating
   it, and it is the same fault T305 found one shape over.
2. The first collision guard would have re-created the dead end it exists to prevent. Inference
   double-assigns a column unaided — a header matching both the name and the division pattern — and
   refusing that hands a director a disabled button naming roles they have no control for. Hence
   `fixable`: a collision is reported only when at least one of its roles can be moved.

## Known limits at close

- **A correction is not remembered.** One import obeys one correction; the next import of the same
  camp's next sheet asks again. The remembered-binding direction (T298's shape, applied to column
  roles rather than labels) is still the right long-term answer and is not closed by this ticket.
- **The machine path cannot state a mapping.** An agent that knows a layout has no way to say so,
  because the CLI reaches past `readPreferenceSheet` to `parsePreferenceSheet` directly. That fork
  predates this ticket — T303's close records the same fork from the subject-identity side — and
  narrowing it would want the same normalisation rather than a second copy of it.
- **The header recognisers are unchanged.** `Pick A` still is not understood; it is now mappable by
  hand. A sheet whose columns a director cannot identify either is still refused, correctly.
