---
title: "Elective preferences enter through an ETL spine: a canonical preference record, replaceable readers, and a director-confirmed axis binding the camp keeps"
document_type: adr
status: proposed
authority: normative
implementation_state: not-started
date: 2026-09-27
task_class: database-sync
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/DESIGN_STANDARD.md]
related_adrs:
  - docs/adr/2026-09-26-general-ingest-for-campers-and-per-cell-preferences.md
  - docs/adr/2026-09-26-per-cell-elective-preferences.md
  - docs/adr/2026-09-17-individual-elective-scheduling.md
  - docs/adr/2026-09-18-schedule-shape-gate-per-page-granularity.md
  - docs/adr/2026-09-23-elective-run-lifecycle-and-remaining-slices.md
  - docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md
related_tickets:
  - docs/work/tickets/T278-import-agnostic-elective-preferences.md
  - docs/work/tickets/T265-minimum-headcount-to-run.md
  - docs/work/tickets/T226-camper-preference-import.md
---

# Elective preferences enter through an ETL spine: a canonical preference record, replaceable readers, and a director-confirmed axis binding the camp keeps

## 0. For the owner — the premises, in plain language, before any decision

You asked to see the different premises, not a finished answer. Here they are. Each one is a
different belief about where the problem actually is. I recommend one at the end and say how
confident I am.

**The thing that is broken today, in one sentence.** If a camp hands us a planner grid — days
across the top, periods down the side, one activity written in each box — the app reads it, reports
success, and throws away *which box each choice came from*. "Archery on Monday in period 3" becomes
"archery, sometime." No error, no warning, nothing on screen. The camp's schedule is then built from
preferences that lost the only thing that made them specific.

**Premise 1 — "Stop guessing. Make the director tell us what the document is."**
The app's two worst import incidents both involved it guessing — though, as §10 sets out, what
actually did the damage in each case was writing the guess without anyone seeing it. The fix on this
premise is to stop guessing altogether: the director
states what the file is and how it is laid out before we open it, and if the file does not match,
we refuse. *What has to be true for this to win:* directors can accurately describe a file they may
not have made. *What it costs them:* a form to fill in before every import, and a refusal they may
not know how to satisfy — at which point they retype the schedule by hand and we have lost.
*Verdict:* **half of it wins.** The document's *kind* ("this is a preferences form, not a
menu of what's offered") is something a director always knows and a computer keeps getting wrong, so
they should state it. The *layout* is something they often cannot describe but can instantly
recognise, so we should propose it and let them correct it. Declaring what they know, proposing what
they don't.

**Premise 2 — "Don't learn anything. Just make the loss impossible to miss, and easy to fix."**
Every import ends with a plain accounting: here is what we read, here is what we did not read, here
is what we could not place in a period. We keep the original file, so a wrong reading can be re-read
without re-uploading. No memory, no profiles, no cleverness — and we record every correction so that
later we know what is actually worth remembering. This repo already did exactly this once before,
shipping a record of directors' decisions *before* anything that learned from them, on the reasoning
that you cannot learn from decisions you never wrote down. *Verdict:* **this is the first half of
the answer and it is not optional — but on its own it is only half the ask.** You asked for the
software to get better; a design that asks the same question every June is not getting better. I am
folding it in as stage one rather than treating it as the whole plan.

**Premise 3 — "Give them our template and have them fill it in."**
The app already does this on several setup screens: download a spreadsheet in our shape, fill it,
import it. *Verdict:* **your ruling kills it as an import path, and the real files confirm the
ruling was right.** You said we are reading someone's data, not choosing how they import it. The
difference with those setup screens is that there the director is *authoring* data that does not
exist yet. Here the data already exists, in a file, in their hand — and for this camp it exists
inside a family portal we do not control at all. Asking them to reshape it moves our work into their
morning. **I think one narrow thing may be worth keeping — a last-resort escape hatch for a file we
genuinely cannot open, offered only after we have tried and said so plainly, never as a menu option
beside "import". But that sits on the far side of a ruling you closed, so I am asking rather than
deciding: it is question 7 in §9. If you say no, it goes, and nothing else in this design changes.**

**Premise 4 — "What should the software actually remember?"** Four candidates.
*(a)* Which column is which — easy, but it is the thing we already do, and it has no way to
represent a grid at all, so it would keep flattening confidently. *(b)* A classifier that guesses
what kind of document this is — a trap: it answers a question the director already answered by
clicking "import preferences", and it would score beautifully while fixing nothing. *(c)* A saved,
named import profile — real, but it is a *container*, not a thing learned; ship it and you have
storage with nothing worth storing in it yet. *(d)* **Where the axes live** — that this camp's
preferences are per day-and-period, that the days are the columns and the periods are the rows.
*Verdict:* **(d) is the unit.** The bug you are asking me to fix *is* an axis-binding failure, in
its entirety. It is also the most stable thing about a spreadsheet: a camp that thinks in
day-by-period still thinks that way next year after someone inserts two columns. (c) is how we store
and version (d). (a) falls out of (d). (b) is dropped.

**Premise 5 — "Run the transform as a service / MCP step rather than inside the app screen."**
You raised this and it deserves a real answer rather than a dismissal. *Verdict:* **yes as a seam,
no as a deployment.** The transform must be one pure module that the import screen, the command
line, and the existing MCP tools all call — because the app's worst incident happened precisely when
one path reached the data *without* passing through the gate the other path used. But that module
should run locally, in the app, not behind a network service: the data is children's names, the app
is deliberately local-first with no account server, and a hosted transform would be the first thing
in this product to send camper data off the device. Same seam, same code, no server.

**Premise 6 — "Pick the one preference model that camps really use."** **Falsified by your own
files, and I want to be blunt about it because it is the most decision-relevant thing I found.** I
read the sheets you supplied. One camp, one season: the 5th-grade planner asks for a choice *in each
box* **and** a ranked top-5 fallback on the same page, while the top-25 form asks for a flat
ranked list of 25 with no days or periods anywhere. Any design that picks one model is already
wrong. The nullable per-cell field decided in the September per-cell ADR is now evidence-backed
rather than a guess.

**What I recommend.** Build the *middle* of the pipeline first, not the reader. Define one canonical
preference record that everything downstream consumes, make each file-reader a small replaceable
adapter that produces it, make everything the adapter could not read visible and correctable, and
let the camp keep a confirmed, versioned statement of where its axes live so the second import is
one glance instead of a fresh interrogation. Learning here means *infer, show, confirm, remember* —
not a trained model, and I am not smuggling one in. "Iterating" means a number that goes up against
a corpus of generated files, plus a second number — silent wrong readings — that must go to zero.

**Confidence: high on the canonical record and the ETL spine; LOW-TO-MEDIUM on the learned axis
binding, and I want to be exact about why rather than sound more finished than I am.** The first
rests on things I verified in the code and in your own files, including running the relevant function
to check a claim I had made wrongly (§3.1). The second has **two** gaps, and the second gap is the
bigger one:

- *The one I can name and partly mitigate:* a director shown their own grid with the axes drawn on it
  may not recognise a wrong reading in one glance. §7 now requires the surface to read one real
  camper's answer back in words, because the overlay alone provably cannot catch the likeliest error.
- *The one that is simply not designed yet:* **how the app recognises that a new file is "the same
  shape as last June" is not specified in this document.** That matching rule is the entire mechanism
  by which remembering pays off, and the claim I make for it in §0 premise 4 — that it survives
  someone inserting two columns — is a claim about a matcher I have not written down. §6 says this
  plainly. **It needs its own design round before anyone builds stage 3, and approving this ADR should
  not be read as approving a matcher you have not seen.**

---

## 1. Evidence — what was read, and by whom

**Read directly for this ADR** — three **blank** planner/menu PDFs supplied by the owner and held
outside the repository. They are not committed, and never will be. They contain no camper's
responses; only their structure is described below.

- a 2024 grades-7–8 activity selection sheet, pages 1–2 (Kind 1, with its swim-alternative page)
- a 2025 5th-grade schedule planner, page 1 (Kind 2)
- a fillable "top 25 activity list" form, page 1 (Kind 3)

**Three document kinds, one camp, one season.** This is the T224 lesson made concrete: three
documents that all look like "elective spreadsheets" and mean entirely different things.

| Kind | Artifact | What it is | What it is NOT |
|---|---|---|---|
| 1 — offerings menu | the grades-7–8 selection sheet | day × period grid whose cells list the activities **offered** there | nobody's preferences |
| 2 — planner | the 5th-grade schedule planner | blank day × period grid the camper fills, **plus** a ranked "NEXT 5 CHOICES" column | not authoritative — see footer |
| 3 — global ranked list | the fillable top-25 form | flat 1..25 ranking, no period dimension at all | carries no cell structure |

*(The two grids are referred to below as the **7–8 grid** and the **5th-grade grid**. Division and
camp names are omitted deliberately; see §9's note on camp-identity exposure.)*

**Verified details that bear on the design, with what I saw:**

1. **Both grids put periods in the ROWS and days in the COLUMNS.** the 5th-grade grid: `PERIOD` column, rows
   1–7, columns MONDAY..FRIDAY. the 7–8 grid: same orientation. Today's reader
   (`src/ingest/preferenceSheet.js:38-63`) only ever reads a header row and maps columns to roles;
   it has no concept of a row axis at all.
2. **the 5th-grade grid selectable-cell count is 18 of 35**, which I counted from the page: 7 periods × 5 days,
   minus INSTRUCTIONAL SWIM (5), FREE SWIM (5), LUNCH (5), BUNK UNITY (Mon P2) and SHABBAT (Fri P2).
   That independently confirms the "18 of 35" figure
   `docs/adr/2026-09-26-per-cell-elective-preferences.md` already records.
3. **the 7–8 grid selectable-cell count is also 18**, by a *different* arrangement (P2/P4/P5 fixed
   camp-wide rows, Mon P1 "BUNK UNITY (no selection needed)", Fri P6 SHABBAT). Same number, different
   geometry — a reader keyed to a remembered geometry rather than a remembered *axis structure* would
   get this wrong between divisions of one camp.
4. **The Swim Alternative page changes the selectable-cell count per CAMPER, not per division.** It
   is headed *"[two older divisions] Campers Only - entering 6th - 8th grades"*, applies to **period 2 only**,
   and instructs *"You must make selections for all 5 days"*. So an opted-out the 7–8 grid camper has 23
   selectable cells where an opted-in one has 18. **This corrects a framing in my brief**, which
   described the opt-out as swapping to "a different offerings set": it swaps *one fixed row into a
   selectable one* and supplies that row's own offerings. The consequence is sharper than the
   original framing — **the set of cells a camper must fill is a function of that camper's
   eligibility, so it cannot be computed once per division and reused.**
5. **A glyph legend is printed across the top of the sheet**: *"Remember to fill in double periods as
   they are indicated by ↓ and ↑"* and *"Remember: multiple day activities are indicated by ► or ♫♫♫
   or *** or → and ← or ⇒ and ⇐"*. **Transcribed from a rendered page image, so treat the exact glyph
   repertoire as approximate and re-read the source before any code keys on a specific character** —
   an earlier draft of this line miscounted one of them. These map onto concepts this repo already has — spans
   (`project_arbitrary_length_span`, PR #145) and multi-day linkage (D14 records linkage as a catalog
   property). They are **offerings metadata on a Kind 1 document**, not preference data.
6. **Kind 1 cells are packed multi-value lists**, laid out as two sub-columns per day. A Kind 1 cell
   is a *set of what is available*; a Kind 2 cell is *one chosen activity*. Identical geometry,
   opposite meaning. Nothing but the declared kind separates them.
7. **Kind 3's ranks are a priority gradient**, labelled on the page *"starting from #1 (must have)
   to #25 (would like to have)"*, with a division-gated opt-out checkbox and a free-text
   "Additional Comments" box.
8. **Kind 2's footer** says *"This document should only be used as a planning tool. Final schedule
   requests must be made electronically through your Camp InTouch portal."*

**Relayed to me from a parallel research pass, and treated as stated** — verified vendor mechanics
for Google Forms, Typeform, Microsoft Forms, Jotform, and partial for Formstack; and the important
**negative result that no camp-management platform publishes a column-level spec for an
elective-selection export, and no sample was found for any of them.** I have not independently
verified the vendor mechanics and do not restate them as design premises beyond §3.4. Camp InTouch is
CampMinder's family portal, so **the file that carries this camp's actual answers is an export nobody
involved has seen.**

**Prior evidence in the repo, verified by reading:**
`docs/adr/2026-09-17-individual-elective-scheduling.md` **D14** (lines 481–560) recorded both the
globally-ranked list and the planner-plus-alternates shapes from real artifacts, withdrew the
ranked-per-occurrence premise, and stated the limit that still governs this ADR: *"The artifacts seen
were blank forms and catalog sheets, not filled-in responses… the format this app would actually
ingest is an export nobody involved has seen… No design should treat either observed format as
confirmed input."* Everything in §1 above is **blank forms again**. D14's limit is not lifted by this
ADR; it is re-stated in §9 Q1.

## 2. The contradiction I was briefed on, and what the code actually says

My brief cited `docs/adr/2026-09-17-individual-elective-scheduling.md` "decision 4" for *"Nothing is
inferred"* and flagged it as a hypothesis. **It is real but narrower than the brief implies.** It is
**D2 item 4** (line 96–97): *"The **director** chooses week, schedule route, division, offerings,
mapping resolutions, manual changes, and finalization. Nothing is inferred."*

The scope matters. It enumerates *the director's decisions* — and **`mapping resolutions` is on that
list**, which is exactly the clause this ADR needs. But it is not a blanket prohibition on the
importer *proposing*. The ingest path's documented bias is the opposite and is deliberate
(`src/ingest/extractEntities.js:11-13`: *"Over-inclusion is the deliberate bias. A wrong row the
director deletes costs them a moment; a missing row they never notice costs them the retyping this
feature exists to remove."*). **Ruling: D2.4 governs the RESOLUTION, not the PROPOSAL.** The app may
propose an axis binding; it may never *resolve* one without the director. That is the reading this
ADR builds on, and it is stated here because a brief that read D2.4 as "no inference at all" would
have produced premise 1 in its maximal, losing form.

## 3. Decision — the ETL spine

**Decision. The design's centre is the canonical record and the transform into it. The reader is a
replaceable adapter.** Concretely, four stages with three named contracts between them:

```
  EXTRACT          TRANSFORM                  RESOLVE                   LOAD              USE
  (adapter)        (pure, one module)         (caller, at solve time)   (writer)          (solver)
  file bytes ──▶ RawTable + DeclaredKind ──▶ PreferenceBinding[]  ──▶ preferences    ──▶ elective_
                       + AxisBinding          + Residue[]              carrying an       assignments
                                              ─ coordinate             occurrence_id
                                                (day,period)           or NULL
                                              ─ resolved against     ──▶ describeElectiveRunRefusal
                                                deriveOccurrences        ──▶ commitElectiveRun
```

**RESOLVE is a distinct stage and omitting it was an error in round 1 of this ADR.** See §3.1.

### 3.1 The canonical record

**ROUND 5 — THIS RECORD CHANGED SHAPE. READ §12.1 AND §12.2a. ROUND 6: the literal record block
below is STALE — §13.3 carries the current shape, including `divisionLabel` and `rankKind`.** It carried a `division` with nowhere
to go, and its preference count was the number parsed rather than the number written. Both are
corrected in §12; `campers` gains `division_label` at schema **v79**.

**Decision: the canonical unit is the `PreferenceBinding` designed in
`docs/adr/2026-09-26-general-ingest-for-campers-and-per-cell-preferences.md` §4.1, with the
nullability of its two cell legs NEWLY ADDED here.** It is:

```
{ camperName, camperExternalId|null, dayName|null, periodLabel|null,
  choiceLabel, rank, source: { page, row, column } }
```

> **The nullability is a CHANGE, not a carry-forward, and must not be approved as though it were
> already reviewed.** The absorbed ADR prints `dayName, periodLabel` **without** it
> (`docs/adr/2026-09-26-general-ingest-for-campers-and-per-cell-preferences.md:181`) and carries no
> prose on the whole-run case at the binding level. Round 1 of this ADR called the unit "carried
> forward unchanged in shape" — wrong, and wrong about the property this document leans on hardest:
> nullability *is* the whole "premise 6 is dead" argument. It is well-founded — §1's evidence and the
> already-accepted nullable `elective_preferences.occurrence_id` both support it — but it is proposed
> here for the first time, and it is listed as amendment 5 in §5.

Two properties make it the right canonical record and both are load-bearing:

- **`dayName`/`periodLabel` are nullable, and that is what lets one record carry all three observed
  kinds.** A Kind 2 grid cell binds with both legs present; a Kind 3 row binds with both absent; a
  Kind 2 "NEXT 5 CHOICES" entry binds with both absent *on the same document as* cell-scoped
  bindings. **This is §1's finding 6 in data form, and it is why premise 6 is dead.** It lands on
  `elective_preferences.occurrence_id`, which is nullable by
  `docs/adr/2026-09-26-per-cell-elective-preferences.md` and which I verified in the schema at
  `electron/db/localDb.js:3693-3700`: `occurrence_id TEXT`, no NOT NULL.
- **It is template-agnostic.** A binding names a coordinate (day, period), never an
  `occurrence_id`; the caller resolves the coordinate against `deriveOccurrences` at solve time. The
  general-ingest ADR §5 establishes why — the two candidate schedule routes yield two different
  `occurrence_id`s for one coordinate and neither route is canonical (CLAUDE.md), so a binding keyed
  to an occurrence would be a statement about a schedule rather than about a child.

### 3.1a The RESOLVE stage, and the error round 1 of this ADR made

**ROUND 5 — THIS SECTION UNDER-SPECIFIED THE STAGE THAT MATTERS. READ §12.0. ROUND 6: and §13.1 —
`sameNameCampers` refuses a correctly-read grid, the same refuse-everything class as below, one gate
to the left.** RESOLVE is not only
coordinate→occurrence binding: it is **five** resolvers under one rule, and it is what closes every
one of the seven measured silent misses.

**Round 1 said `commitElectiveRun` "stays exactly as it is … this ADR changes none of it". The
clause about the code is true; the premise underneath it — that the refusal gate is neutral about the
binding's shape — is false, and it made the design as written refuse every grid.** Recorded here
rather than quietly corrected, per this repo's D14/D4 convention.

**Verified by executing the real function**, not by reading it:

```
18 preferences, rank: 1, no occurrence_id      → hasContradictoryRanks === true   (REFUSED)
18 preferences, rank: 1, distinct occurrence_id → hasContradictoryRanks === false  (accepted)
```

The mechanism is the key at `src/ingest/preferenceSheet.js:180`,
the camper id, the occurrence id (empty string when absent) and the rank, joined by a NUL delimiter.
*(Described rather than quoted on purpose: a draft of this line pasted the escape and emitted two raw
NUL bytes into this file, which is the authoring hazard `electron/db/localDb.js` warns about and the
reason searches here need `grep -a`.)* §4.2 below rules a cell choice is
**rank 1 by construction**, so a 5th-grade camper's 18 cell choices all collapse onto the single key
`camper\0\01` and the second one trips the refusal *"a camper holds the same preference rank twice"*.
**The `occurrence_id` is the only component that makes two rank-1s legal** — the function's own
round-3 comment (`preferenceSheet.js:152-167`) says exactly that, and round 1 of this ADR cited that
comment while missing what it implied for a coordinate-keyed binding.

**Ruling: RESOLVE is a named stage that runs BEFORE `describeElectiveRunRefusal`, and the caller owns
it.** This is not new — it is the absorbed ADR's §5 and §10 S3 ruling, which round 1 of this document
dropped when it reorganised around the ETL spine: `AssignmentPanel.jsx` (and, after the CLI/MCP
slice, that harness) resolves each binding's `(camper_id, day_id, time_block_id)` against
`deriveOccurrences`' output — the only place the camper's group's tier is known — and passes
**fully-formed preferences** down. A binding never reaches the refusal gate carrying only a
coordinate.

**So the two statements that must both hold, and round 1 asserted only the first:**

1. `commitElectiveRun`'s and `describeElectiveRunRefusal`'s code is unchanged. Verified at
   `electron/ops/commitElectiveRun.js:66-75`: it refuses only a *malformed* `occurrence_id` and
   accepts an absent one as the whole-run fallback, with the owner's ruling quoted at lines 55-57.
2. **The gate is not shape-neutral, and the design is only correct because RESOLVE runs first.** A
   grid-derived preference arrives with a non-null `occurrence_id`; a Kind 3 whole-run preference
   arrives with `null` and is accepted on the owner's ruling; a coordinate that RESOLVE could not
   bind becomes **residue**, not a preference (§3.4), so it never reaches the gate at all.

§8's test table now enters through RESOLVE explicitly, and carries a test that would have caught this
(a correctly-read grid must write N rows with **distinct non-null** `occurrence_id`s).

### 3.2 The adapters, and where they run

**Decision: one pure transform module, called from every entry point; adapters are per-shape and
small.** The transform (declared kind + raw table + axis binding → bindings + residue) is pure, takes
no db and no IPC, and lives in `src/ingest/` beside its siblings. The renderer's import screen,
`scripts/ingestCli.js`, and the MCP tools (`scripts/mcp/tools.js`, whose `ingest_preview` /
`ingest_commit` are recorded at `src/ingest/scheduleShape.js:16-18`) all call the same function.

**This is premise 5 resolved: the MCP/CLI seam is required, a network service is refused.** The
requirement is not stylistic — T224 happened *because a path reached extraction without calling the
gate the other path called* (`src/ingest/scheduleShape.js:14-21`). A second transform is a second
T224. The refusal of a hosted service is on the local-first boundary: the payload is children's
names and there is no account server (CLAUDE.md, `SECURITY.md`); a hosted transform would be the
first camper data to leave the device, and that is an owner decision, not an architectural
convenience. Same seam, local execution.

### 3.3 Declared kind is per-page; axis binding is proposed and confirmed

**ROUND 4 — READ §11.2 FIRST. This section's central premise is WRONG. AND READ §13.2: §11.2's own
framing was also wrong about WHEN the checks run — check 1 at parse time, checks 2 and 3 only at solve
time against the template being solved, and both unavailable when the elective set is unplaced.** It designs a reader that
*infers* an axis structure from an unknown grid. Electives are a NESTED schedule inside an
already-defined day: the days and periods, and which coordinates are elective at all, ALREADY EXIST
in the projection when the elective import runs. Axis binding is therefore a **matching** problem
against a known set, with three mechanical checks, not an inference problem with a confirmation
step. Everything below is superseded by §11.2 where the two disagree.

**Decision: carried forward unchanged from the general-ingest ADR §5.1 — the declared kind is
per-PAGE**, because T223 was a per-page defect and a per-import kind reintroduces the whole-file
granularity that `docs/adr/2026-09-18-schedule-shape-gate-per-page-granularity.md` removed.

**Amendment (new here): the kind vocabulary must include `offerings-menu` as a first-class value.**
The general-ingest ADR's per-page kinds were schedule / preference-sheet / neither. §1's Kind 1 is
none of those: it is a day × period grid of *what is offered*, structurally indistinguishable from a
filled planner, and feeding it to a preference reader is T224 verbatim with better manners. The
the 7–8 grid sheet and the the 5th-grade grid planner have the same geometry and opposite meaning; **only the declared
kind separates them, and no amount of shape inference can.**

**And its relationship to the EXISTING per-page classifier must be stated, because round 1 left two
classifiers side by side with nothing said about them.** `isSchedulePage` /
`partitionSchedulePages` / `isScheduleShaped` (`src/ingest/scheduleShape.js`) already classify pages
per page. A Kind 1 offerings menu **is** a day × period grid, so **`isSchedulePage` returns true for
it** — and round 1 of this ADR never said what happens when the declared kind and the shape gate
disagree, nor whether a page declared `offerings-menu` is still admitted as `shaped` when the same
workbook is dragged onto the *schedule* import. My own §3.2 argument applies verbatim: T224 happened
because a path reached extraction without calling the gate the other path called.

**Rulings:**

1. **The shape gate's verdict is the DEFAULT for the declared kind, never an override of it.** This
   is the absorbed ADR §5.1's model, unchanged: the gate proposes, the director declares.
2. **Disagreement is not an error — it is the normal case for Kind 1, and it is surfaced, not
   resolved silently.** `isSchedulePage` saying "schedule" while the director declares
   `offerings-menu` is exactly right for a menu, and the declaration wins.
3. **The declaration is per-page and travels with the page across entry points.** A page declared
   `offerings-menu` is **not** admitted to `extractEntities` as `shaped` on the schedule import path
   either — that is the T223/T224 laundering route, and a declaration that binds on one path and not
   the other would rebuild it.
4. **Neither classifier may be duplicated.** The declared kind is a layer *above*
   `partitionSchedulePages`, reusing its per-page seam; it is not a second implementation of page
   classification.

**The axis binding is proposed with a stated confidence and confirmed by the director** — never
resolved silently (§2). It states, for a page: which axis carries days, which carries periods, where
each label lives, and whether the page also carries an unscoped ranked list. The confirmation surface
is the director's own grid with the axes drawn on it, not prose (DESIGN_STANDARD §5/§8 apply; see §7).

### 3.4 Residue — the loud half

**Decision: every import produces a `Residue[]` alongside the bindings, and it is non-empty by
default until each item is claimed or waived.** Residue items name: cells read but not bound, columns
unconsumed, an axis the reader could not bind, and — **the item this whole ticket exists for** — *a
page whose geometry suggests a day/period grid that was bound as unscoped*.

**This is the fix to the stated defect, and it is deliberately not a refusal.** A whole-run ranked
list legitimately has no cells (`commitElectiveRun.js:53-57` quotes the owner on exactly this), so a
grid-shaped page read flat cannot be refused — it must be *reported*. The finding is the one thing
that must exist for the owner's hard requirement 1 to be satisfied.

**A grid read as flat is never written as a whole-run fallback without an acknowledged residue
item.** That is the invariant. Absent per-cell scope remains legal; absent per-cell scope *from a
page the reader believed was a grid* is legal only once the director has seen that sentence.

## 4. Four rulings the real artifacts force, which no prior ADR covers

### 4.1 An unordered set is not a rank, and must not be coerced into one

The research relay reports packed multi-value cells as the default for form exports (one cell holding
`"Swim, Archery, Ceramics"`). **Ruling: a packed cell with no ordering evidence produces bindings
with `rank: null` and a residue item, never a rank invented from cell order.** An unordered set of
acceptable activities is a different fact from a ranking and the model has no column for it today.

**This is flagged as a schema question, not answered here.** `elective_preferences.rank` is
`INTEGER` and nullable (`electron/db/localDb.js:3698`), so a null rank is *storable* — but whether
the solver can consume an unranked preference is a scheduling-engine question this ADR does not
decide. See §9 Q4. **Per my brief I do not pick a schema version and do not propose a migration.**

### 4.2 Rank means three different things across the three kinds

Kind 3's 1..25 is an explicit gradient (*"must have"* → *"would like to have"*). Kind 2's grid cells
are not ranked at all — they are *chosen* — while its "NEXT 5 CHOICES" is a ranked **fallback**,
subordinate to the cells. Today's reader recognises only `RANK_HEADER = /^#\s*(\d+)$/`
(`src/ingest/preferenceSheet.js:25`), a bare `#1`.

**Ruling: one integer column cannot carry all three meanings, and the binding needs a companion
`rankKind`** — one of `cell-choice` (the camper's selection for that cell, rank 1 by construction),
`ordered-fallback` (Kind 2's next-5, and Kind 3's list), or `unordered-set` (§4.1). A binding's
`rank` remains an integer; `rankKind` says what comparing two of them means. Whether the solver must
weight `cell-choice` above `ordered-fallback` is §9 Q4.

**And a correction to my brief, which understated this.** The brief called the header regex an
inference the arrangement was "already flexible" around. Against the relayed vendor mechanics —
headers carrying question prose like `Period 1 (9:00–10:15) — pick your top choice` or
`Availability [Monday]` — **`/^#\s*(\d+)$/` matches essentially nothing.** It is anchored at both
ends against a bare `#N`. The existing mapping inference is not a flexible foundation that needs
extending; against real exports it is close to a null result. Stated plainly because the design's
sizing depends on it.

### 4.3 The swim opt-out and the comments box are not preferences

**Ruling: neither may enter `elective_preferences`.**

- The **opt-out** is a per-camper *eligibility* fact, division-gated (§1 finding 4), requiring parent
  permission — the sheet states *"the decision not to participate must involve parents"*. It changes
  **which cells are selectable for that camper**, which is upstream of preference at all. It is
  residue-with-a-name until a home for it is decided; **importing it as a preference would make a
  permission-bearing fact invisible.**
- The **free-text comments box** is unmodelable and must be **preserved verbatim and shown to the
  director, never parsed into structure.** A parser that extracts activity names from a parent's
  sentence is the compound-cell trap at a larger scale, and `src/ingest/compoundCellPatterns.js:6-10`
  is the precedent for the discipline: *"A 3+-part split is silently dropped rather than guessed
  at."* Drop, surface, do not guess.

  **And it needs a stated home, because this is the field most likely to carry a medical, custody or
  safeguarding disclosure about a child, and leaving the storage decision to whoever implements is
  not acceptable for that payload. Ruling: residue-with-a-name, HOST-LOCAL, never replicated, never
  exported.** Host-local for the same reason the five decision tables are
  (`electron/db/schema.sql:226-232`: *"NEVER included in any full-sync SELECT/payload, NEVER sent over
  the wire"*) — and note this is the one place in this ADR where I recommend host-local **against**
  §6's replication recommendation, deliberately: an axis binding is a fact about a spreadsheet, a
  parent's disclosure about their child is not, and the two must not share a storage decision.
  **The export seam is clean today and must stay that way explicitly**:
  `src/screens/elective/export/exportElectiveRunWorkbook.js:67-75` (`buildElectiveRunWorkbook`) builds
  from `buildElectiveRunProjectionExport` and appends four fixed sheets, rather than spreading a row,
  so comments cannot leak into an export unless someone adds them on purpose. That is a property to
  preserve as a requirement, not an accident to rely on. *(The review that raised this cited
  `electron/ops/exportElectiveRunWorkbook.js:69-73`; no such file exists — the module is under
  `src/screens/elective/export/`. The substance of the finding was right and is adopted.)*

### 4.4 Same-name campers — not a second defect, and division must not join the id

My brief asked whether `describeElectiveRunRefusal`'s same-name refusal
(`electron/ops/commitElectiveRun.js:36-44`) is correct behaviour or a second defect, given that most
form exports carry no stable person id.

**Verified:** `deriveCamperId` (`electron/ops/electiveDerivedIds.js:234-247`) already takes
`externalId` and prefers it, falling back to a canonicalized name only when absent. And
`parsePreferenceSheet`'s `sameNameCampers` (`src/ingest/preferenceSheet.js:126-137`) already filters
to rows that collapse onto **one** derived id — rows distinguished by an external id are excluded.
**So the refusal fires only where there is genuinely no id.** The plumbing the owner's identity
ruling needs exists.

**Ruling: correct behaviour, not a defect — and division must NOT be folded into the derivation.**
Two children sharing a name in one division is exactly the case the refusal protects, so division
narrows the collision without eliminating it while silently re-keying every existing camper id
(`electiveDerivedIds.js:41-59` is explicit about what an unbumped derivation version does and does
not guarantee). Division belongs in the **refusal message**, to help the director tell the two rows
apart. The real dissolution of this class is the portal export's person id — §9 Q1.

**The PARTIAL-ID fork, which round 1 of this ADR missed and which is the more dangerous half.** One
child on two rows where **one row carries an external id and the other does not** derives **two
different ids**, so `ids.size === 2` and the `sameNameCampers` filter
(`src/ingest/preferenceSheet.js:126-137`) **excludes it**. No refusal fires. The result is **two
camper records for one child, holding disjoint halves of their preferences** — and per the absorbed
ADR's Trap 4 those rows are unremovable: not in Trash, not restorable, no CRUD screen, remediable
only through the D10 purge path or raw SQL. `electron/ops/electiveDerivedIds.js:227-231` is explicit
that a silent fork of this kind is worse than a visible collision.

**Ruling: a residue item, not a refusal** — *"a camper name appears on rows that resolve to different
identities"*, listing the rows and which of them carried an id. A refusal would be wrong, because two
children genuinely sharing a name where only one has an id is a **legitimate file that must import**,
and only the director can tell that case from the fork. Same reasoning as §3.4's flat-read grid,
applied to identity.

## 5. What this means for the proposed general-ingest ADR — it does not survive alongside this one

`docs/adr/2026-09-26-general-ingest-for-campers-and-per-cell-preferences.md` is `status: proposed`,
`implementation_state: not-started`, never owner-approved, and claims the same territory.

**Decision: it is ABSORBED. On owner approval of this ADR it is withdrawn — its status flips to
`superseded` pointing here — and the rulings listed below are carried forward as part of this
document.** It is not left standing as a second proposal, and it is not simply deleted, because its
verified content is the best part of this design and re-deriving it would be waste.

**Carried forward unchanged** (each verified by reading that document):
§2.1 `elective_preferences` is run-scoped and cannot be an `INGESTIBLE_ENTITIES` member; §4.1
bindings travel beside `approved`, not inside it, on the `fixedEvents[]` precedent; §4.2 the
confirmable units are the vocabulary and the layout, not one card per binding (~7,200 is not
reviewable); §4.3 (a)–(d) the four rank-contradiction rulings, including that identical duplicate
rows deduplicate silently and only conflicting ones refuse; **§5 and §10 S3's ruling that the CALLER
binds a coordinate to an `occurrence_id` against `deriveOccurrences` — see §3.1a, which round 1 of
this ADR dropped**; §5's three layout shapes and the correction that `isDayName` cannot be called on
a compound header; §5.1 per-page declared kind; §9's traps; §10's consumer inventory and retirement
path.

**And its §8 sub-rulings, restated here rather than compressed into "no schema version required" —
because §5 amendment 2 and §9 Q3 of THIS ADR reverse that clause, so a reader who follows the
compressed form lands on a conclusion this document no longer holds:**

- **§8.1 — `campers` as the eighth `INGESTIBLE_ENTITIES` member touches FIVE arrays across three
  files**, two of them order-critical and one of which **throws at runtime** when wrong
  (`PRAGMA foreign_keys` is ON): `extractEntities.js:35`, `ingest.js:52`, `U2_DELETE_ORDER`
  (`ingest.js:43`, where `campers` lands **second**, immediately after `anchor_activities`),
  `U2_DELETABLE_ENTITIES` (`undoReferences.js:136-138`), and `REPLACEABLE_ENTITIES`
  (`ingest.js:64`). Plus: **`campers.group_id` has NO `REFERENCES` clause** (`schema.sql:1304`), so a
  Replace that drops `groups` does not throw — it **silently orphans every camper's group**, and an
  orphaned group means no tier, which means `deriveOccurrences` can resolve no cell for that camper.
- **§8.2 — the order tripwire DOES NOT EXIST.** Both real assertions sort before comparing, so **a
  Maker who puts `campers` in the wrong position of any of the five arrays gets a green gate.**
  Building that assertion is work in stage 1, not a safety net to be discovered.
- **§8.3 — making `campers` U2-deletable invalidates three documented `ACCEPTED_NON_REFERENCES`
  exemptions** (`undoReferences.schemaParity.test.js:150`, `:156`, `:163`), each of which states as
  its reason that `campers` is not U2-deletable. The consequence if missed is not a red test: **Undo
  Import after a finalized run would tombstone camper rows with no referential blocker, leaving a
  published run pointing at children who no longer exist.**
- **§8.4 — `campers` is absent from `electron/auth/permissions.js` ENTITIES by design**, and this is
  a **read** question as well as a write one: three sites loop `INGESTIBLE_ENTITIES` calling
  `list(entity)` and would begin reading the PII roster into the renderer
  (`src/ingest/existingSnapshot.js:30,46`, `electron/ops/ingest.js:264`,
  `src/utils/downloadWorksheet.js:11-14`).
- **§8.5 — the governance deliverables** that land with the work.

**Amendment 5 (NEW, and the one most easily missed): the binding's `dayName`/`periodLabel`
nullability originates HERE**, not in the absorbed ADR, which prints them non-nullable at its :181.
See the callout in §3.1.

**Amended by this ADR:**
1. **Its spine.** It is organised around the reader; this one is organised around the canonical
   record, per the owner's reframing. Its reader design becomes §3.2's adapters.
2. **§5's "the layout is confirmed per import and not persisted", with its own §12 Q2 recommending
   "not yet".** This ADR reverses that recommendation — the persisted axis binding is the unit of
   learning (§6) and is the substance of the owner's ask. Its Trap 6 already priced the cost of not
   persisting; that cost is now being paid down. **It remains schema-bearing and therefore an owner
   question, not a decision I may take (§9 Q3).**
3. **Its per-page kind vocabulary**, extended with `offerings-menu` (§3.3).
4. **New material it does not contain at all:** §4.1 unordered sets, §4.2 `rankKind`, §4.3 opt-out
   and comments, §4.4 identity, §6 the learning layer, §7 the corpus and the acceptance metric.

Its §12 open questions Q1 and Q3–Q6 are **unresolved and carried into §9** — they were never
answered because it was never approved.

## 6. The learning layer — inference, confirmation, memory. Not a model.

**ROUND 4 — READ §11.2 FIRST.** What is learned is a **permutation over existing day/period ids**,
not a discovered geometry, and most of what this section asks a director to confirm is mechanically
verifiable instead. §6.1's and §6.3's rulings survive; their load drops.

**Decision: "machine/software learning" here means a director-confirmed, per-camp-remembered axis
binding, in the style of T118's compound-cell patterns. No trained model.** I considered arguing for
one and am recording why not: a model needs labelled examples, and §1's evidence is *blank forms
from one camp*; D14's limit still stands; and a model's wrong answer is unexplainable to a director
where a stated axis binding's wrong answer is a sentence they can read and flip. **If a corpus ever
makes a model justifiable, that is a later ADR with its own evidence, not a quiet extension of this
one.**

**The unit is the axis binding, held in a versioned per-camp import profile** (premise 4(d) inside
4(c)). What is remembered is *where the axes live and what the page's kind is* — not column indices,
which shift the moment anyone inserts a column and shift *silently*.

### 6.0 What is NOT specified here, stated plainly because the gap is bigger than the UX risk

**Three things this ADR does not contain, and stage 3 cannot start without them:**

1. **The signal that produces a proposal.** §6 below gives the axis binding a `CONFIDENCE` tier, but
   **a confidence tier with no strength function is a field, not an inference.** What evidence scores
   a candidate binding, and how, is unwritten.
2. **The stored record's field list and its key.** §3.1 gives a literal record shape for the
   canonical half of this design; this half has none. That asymmetry is the tell, and it is why this
   subsection exists rather than the gap being left for a reader to notice.
3. **What constitutes a MATCH on re-import, and what "drifted" means.** This is the most important
   omission, because **matching-and-drift IS the mechanism** — the entire payoff of remembering. §0
   premise 4's selling point, that an axis binding survives someone inserting two columns, is a claim
   about a matcher **this document does not contain.**

**Ruling: the profile record and the match key are NOT YET SPECIFIED and require their own design
round before stage 3 is briefed.** Approving this ADR approves the *unit* of learning and its
lifecycle position, not a matcher nobody has seen. §0's confidence statement says the same in the
owner's language.

**One constraint on that future matcher is ruled NOW, because getting it wrong is a privacy defect
rather than a design preference: the match/drift key must be derived from header text, axis labels
and geometry ONLY — never from cell contents.** A fingerprint computed over cells would cache
children's names into a table §6 recommends **replicating**, turning a layout memo into a covert
roster. This constraint is cheap to honour up front and expensive to retrofit.

**How it relates to what already exists**, as my brief requires:

- **`src/ingest/compoundCellPatterns.js` + T118** is the direct model: detect candidates, never apply
  them to real data without confirmation, remember the confirmation per camp. Its self-imposed limit
  (lines 6–10 — two-part compounds only, 3+ dropped rather than guessed) is the discipline this layer
  inherits: **an axis binding the reader cannot state confidently is residue, not a guess.**
- **`src/ingest/decisionJournal.js:3-16` is the load-bearing precedent and it sequences this work.**
  Its argument — *"Five tables of yes-answers is a cache, not a signal. You cannot learn from
  decisions you never recorded as decisions, which is why this ships BEFORE any learning does"* —
  applies here with full force. **Ruling: the journal records axis-binding questions and their
  outcomes BEFORE any profile is persisted.** Stage 1 of §8 is therefore premise 2's design, in full,
  and the profile is stage 3. This is the repo's own sequencing, not a compromise.
- **`src/ingest/confidence.js`** supplies the vocabulary; the axis binding carries a `CONFIDENCE`
  tier. **Note for whoever implements: `MEDIUM` is currently unreachable** — `mediumThreshold`
  defaults to `highThreshold` (lines 12–14) — so a design wanting three tiers must pass an explicit
  `mediumThreshold`, which is a behaviour change at that call site and needs saying out loud.
- **`src/ingest/attentionList.js`** is where an unconfirmed binding and an unacknowledged residue
  item surface to the director, rather than a new notification surface.

### 6.1 A confirmed-wrong binding — the failure this design creates, and the controls that answer it

**This is the most serious consequence in this document and it is a failure mode the design
INTRODUCES rather than inherits.** Once a director confirms a binding, it is wrong in a way nothing
can see: it carries **no residue** (it was confirmed), **no low confidence** (confirmation is the top
tier), it is re-proposed **pre-confirmed** on every matching re-import, and §8's dominating
safety metric — which scores the *proposal* against ground truth — never looks at it. A grep for
`unlearn` / `forget` / `invalidat` / `revoke` across the ingest layer returns no invalidation
mechanism. **So a wrong reading, once blessed, is permanently silent, and only byte-drift dislodges
it.** That is strictly worse than today's defect, which at least fails identically every time and can
therefore be found.

**Four rulings, and stage 3 may not ship without all four:**

1. **Confirmation is revocable and the revocation is a first-class act.** A binding carries the
   import it was confirmed on and by whom; "forget this reading" invalidates it and drops the next
   import to the full primary-response questioning. Drift must not be the only invalidator.
2. **A remembered binding expires by season, not by time.** Re-use across a season boundary
   re-confirms rather than auto-applying — the cheapest possible catch for "last year's form was
   re-cut", and it costs a returning director one glance per season, not per import.
3. **Metric 2 covers REMEMBERED bindings, not only proposed ones** (§8). The corpus must include the
   re-import case, so a confirmed-wrong binding that silently re-applies counts as a silent miss. A
   metric that cannot see the design's own worst failure is decoration.
4. **There is a review surface for "how we read this camp's form"** — a director can see every
   remembered reading, when it was confirmed, what it has been applied to, and revoke it. Without
   this, ruling 1 has no door. Per the standing no-banners rule this lives with the existing setup
   surfaces, not as chrome.

**Honest residual:** none of the four detects a wrong binding *by itself*; they make it **findable
and reversible** rather than permanent and invisible. Detection still rests on §7's read-back.

**The trap my brief asked me to name, and it needs an owner ruling.** The five decision tables
`decisionJournal.js` names are **host-local**, while the camp's data is a replicated Automerge
document. If the axis binding follows that precedent, the concrete failure is: *the office laptop
learned the shape in June; in August the director imports the updated sheet from her own laptop,
gets the naive reading, and the grid flattens — the exact defect, reintroduced by storage placement.*
Worse, two devices then hold different readings of the same file and the merge preserves both
faithfully.

### 6.2 This is the "seedlings" slice under a different name, and that must be reconciled

**`electron/db/schema.sql:245` and `:251` already reserve `import_decisions.seedling_key`
(*"generalized learning key — unused (NULL) until slice 3"*) and `learned_from_id` (*"id of the
camp_seedlings row that pre-filled this"*), citing
`docs/superpowers/specs/2026-09-15-seedlings-importer-learning-design.md`.** Neither of my documents
said "seedling" once before this paragraph. **A per-camp import profile that pre-fills a director's
answer from a remembered confirmation is functionally that slice**, and shipping it under a new name
would leave the repo with **two learning substrates and two reserved columns whose comments have
become false.**

**Ruling: stage 3 is the seedlings slice-3 substrate, or it explicitly supersedes it — and that is
settled by reading that spec BEFORE stage 3 is briefed, not by picking one here.** I have not read
it, so I record this as an unreconciled collision rather than resolving it from the column comments
alone. **Either way the two reserved columns are in scope for stage 3**: they are filled, or their
comments are corrected. A persisted column whose comment describes a mechanism that never arrived is
the kind of stale annotation a future reader will interpret against.

### 6.3 Replication, and the asymmetry it creates with the journal

**My recommendation is that the axis binding REPLICATES, against the host-local precedent** — it is a
fact about the camp's own form, no more device-specific than the camp's period names, and its failure
mode under replication (two directors confirm conflicting readings → a `conflicts` row a human
resolves) is the mechanism this app already uses for that class of disagreement. **But this is a
schema-bearing, sync-semantics decision and it is §9 Q3, not a ruling I take here.** The host-local
tables are local for their own defensible reasons and departing from them deserves the owner's nod.

**Two corrections to that recommendation's support, which round 1 asserted too easily:**

- **The `conflicts` row is not automatic — it depends on how the record's id is derived.** Conflict
  detection is keyed per `(entity, entity_id, field)` (`electron/ops/projections.js:1056`), so two
  devices produce a conflict **only if they derive the same id for the same remembered reading.** If
  the id is minted per confirmation — the neighbouring pattern, e.g. `randomUUID` for `runId` at
  `electron/ops/commitElectiveRun.js:16` — you get **two records, no conflict row, no human, and an
  arbitrary winner.** So §9 Q3 must also ask **what the id is derived from**, and whether the natural
  key is registered with `detectUniqueFieldCollision`; this repo relaxed ten name indexes at v73 over
  exactly this class of mistake.
- **The journal stays host-local while the profile replicates, and that asymmetry has a cost I should
  name rather than leave implicit.** `import_decisions` is host-local and never synced
  (`electron/db/schema.sql:226-232`). So device B receives the binding and **none of the decisions
  that produced it** — and stage 4's two numbers, computed from that device's journal, describe a
  per-device subset **with no way to know that they do.** I still recommend replicating the profile
  (the failure it prevents is worse), but **stage 4 must either aggregate the journal deliberately or
  state on the face of the numbers that they are device-local.** Silently reporting a subset as a
  fleet measurement is the "green verdict that lies" pattern this repo has been bitten by.

## 7. Design-standard obligations (UI-touching)

Two new surfaces make this UI-significant, so `docs/governance/standards/DESIGN_STANDARD.md` is a
hard constraint on the implementing brief, not a review-time discovery:

- **The axis-binding confirmation** — the director's own grid with the axes drawn on it (§3.3). It
  has loading, error and confirm states; §5 (motion/feedback) and §8 (transitions) apply, including
  the reduced-motion equivalent, which is *never no feedback*.

  **The overlay alone is NOT sufficient, and this ADR's own evidence proves it.** §1 finding 6
  records that a Kind 1 sheet lays out **two sub-columns per day** — 5 days, 10 data columns, merged
  day headers. An off-by-one or sub-column misbinding **draws the overlay where the labels are, so it
  looks right**: every camper's Friday lands on Thursday and a tired director confirms in one glance.
  §0's assumption holds for a *transposed* binding (5 × 7 is not square, so it is glaring) and
  **fails for exactly the pathology the evidence documents.**

  **Requirement: the surface must read one specific camper's answer back in plain words next to the
  overlay** — *"Ari Green → Friday, period 4 → Archery"* — drawn from the file being imported, with
  the director able to step to another camper. **A coordinate stated in prose is the one artifact a
  merged-cell or off-by-one misbinding cannot survive**, because the director knows what Ari chose
  and an overlay rectangle tells them nothing. This is a functional assertion about the surface, not
  a styling note, and it is the single highest-value control in this ADR.

- **The `campers` confirmation is OPT-IN, not opt-out, and the count is shown before confirm.** This
  is the absorbed ADR's Trap 4, written out here rather than carried as a section number, because it
  is the requirement a Maker could most plausibly skip while shipping something that looks finished.
  A false-positive camper row is **permanent**: not in Trash (`electron/ops/restore.js:80-100` puts
  `campers` in a block headed *"THESE SEVEN ENTRIES ARE A SECURITY BOUNDARY, NOT ONLY A PRODUCT
  DECISION"*), not restorable, no CRUD screen, and no UNIQUE on `display_name` to stop a second row
  for the same child. It inverts the ingest path's documented over-inclusion bias
  (`src/screens/ImportScreen.jsx:1253` copies unfiltered into `approved`) **for this one entity**,
  deliberately. Prevention is the whole answer because every remediation route is a deliberately
  closed door.
- **The residue ledger** — per the standing owner rule, this is **not a banner**
  (`feedback_no_banners_flags_instead`): unacknowledged residue joins the existing per-item flag and
  attention vocabulary (`attentionList.js`), it does not get chrome of its own.

## 8. Test corpus and the acceptance metric — designed here, built later

**Round 2: designed, not built. ROUND 3: BUILT AND RUN — see §8.1 for the measured baseline.** The
design below stands as written; §8.1 records what today's code actually does with it, and names the
two places §8's own expectations were wrong.

### 8.0 The corpus is SYNTHETIC-ONLY — normative, and no gate can enforce it for us

**This is the clause round 1 was missing entirely, and its absence was dangerous rather than
untidy.** §8 correctly requires every test to enter at **file bytes**, which means the corpus files
must be **committed** to be usable — and this repository is bound for public history (T120). Round 1
therefore pushed real children's names toward a public repo while saying nothing about it.

**No gate catches this.** `scanPrivacy` has three content rules — home paths, two hashed-token
shapes at plaintext lengths 5 and 10, and email/phone shapes — and **cannot match an unstructured
personal name**. If fixtures ship as `.xlsx`, `scripts/security-gate.js:295-298` records that
binaries are **path-scanned only, contents never read**. A green gate here would mean nothing at all.

**Normative clauses:**

1. The generator emits **synthetic identities only**, drawn from a committed seeded name list. It
   never derives a name from any real file.
2. **No file derived from a real camp's filled-in responses is ever committed, in any format** —
   not `.xlsx`, not `.csv`, not a JSON transcription, not a "redacted" copy.
3. A real export obtained under §9 Q1 is **held outside the repository**, and only its **structural
   shape** (header positions, axis placement, kind) is transcribed into the corpus definition.
4. **The control the guard cannot provide, built as work:** a test asserting that **every camper name
   appearing anywhere in the corpus comes from the synthetic name list**, so a hand-added real name
   fails the gate. This is the non-vacuity principle applied to privacy — the guard's own description
   is part of the guard, and here the guard is blind, so the test is the only real control.

**Generator precedent:** `scripts/fixtures/make-elective-cell-fixture.mjs` and
`test/fixtures/elective/t251-per-cell-preferences.json`. **The named hazard is that a generator
emitting ONE shape leaves the other paths untested and a green suite then describes half a feature**
— so the generator is parameterised over shape, and a test asserting coverage of all shape classes is
part of the corpus, not an afterthought.

**Shape classes, from §1 plus the research relay's negative result:**

| Class | Basis | Status |
|---|---|---|
| A — planner grid, periods in rows | 5th-grade / 7–8 | **observed** |
| B — global ranked list, no cells | the top-25 form | **observed** |
| C — both on one page (grid + ranked fallback) | the 5th-grade grid | **observed** |
| D — offerings menu (must be declined by the preference reader) | the 7–8 grid | **observed** |
| E — compound header, one row per camper (`Monday Period 3 - 1st choice`) | relayed vendor mechanics | plausible |
| F — packed multi-value cells, unordered | relayed vendor mechanics | plausible |
| G — grid question + packed cells simultaneously | relayed (Google Forms grid) | plausible |
| H — camp-platform portal export | **unknown shape class** | **unseen — must be modelled as unknown, never fabricated** |

**Class H must not be invented.** The research pass established that no camp platform publishes a
column-level spec and no sample was found. A fabricated CampMinder layout in the corpus would be a
green suite describing a format nobody has seen.

**Scale.** The owner has sanctioned generation at scale (*"we could fill out 500 of these to model a
huge camp"*). Size the corpus to one realistic camp: ~500 campers across divisions with different
geometries (the 5th-grade grid’s 18-of-35 and the 7–8 grid’s 18-of-35-differently, §1 findings 2–3), including opted-out
campers whose selectable-cell count differs (finding 4).

**Non-vacuity — the bar my brief sets, and which path each test enters through.** Three instances of
hand-built-`parsed`-fixture tests asserting on the fixture rather than the system are on record (T62,
T197 round 1, the v78 fallback row). Therefore:

| Test | Enters through | Asserts |
|---|---|---|
| **a correctly-read grid writes N rows with DISTINCT NON-NULL `occurrence_id`s matching the source cells** | file bytes → adapter → transform → **RESOLVE** → `describeElectiveRunRefusal` → `commitElectiveRun` | 18 rows for an 18-cell planner, each `occurrence_id` distinct and non-null, each matching its source cell; **and the run is NOT refused** |
| **a confirmed-WRONG binding is caught on read-back and is revocable** | the same full path, then the §6.1 revoke act | the read-back sentence names the wrong coordinate; after revoking, the next import re-asks instead of pre-filling |
| grid-read-flat produces a residue finding | file bytes → adapter → transform → RESOLVE → `describeElectiveRunRefusal` → `commitElectiveRun` | a residue item exists and the commit is NOT refused |
| declared `offerings-menu` yields zero preference bindings | the same full path | no `elective_preferences` rows, and the menu's activity names never reach `groups`/`tiers` (T224 regression) |
| Kind 3 (no cells) still commits | the same full path | rows written with `occurrence_id IS NULL` |
| a confirmed axis binding is reused on re-import | two sequential imports of the same bytes | second import proposes the binding pre-confirmed; **and re-import is idempotent** |
| the binding does NOT auto-apply to a drifted file | import of a mutated file | the match fails and the director is asked again |

**Every one of these enters at file bytes and exits at the database.** A test that constructs a
`parsed` object by hand and asserts on it is explicitly not acceptable evidence for any row above.

**Note what the first row buys.** Without it, the other five all go green on an implementation that
**refuses every grid** — which is precisely the state §3.1a shows round 1 of this ADR had designed.
It is the one test that asserts the stated defect is actually fixed, and it is first for that reason.

**The acceptance metric, because otherwise this is not learning, it is more code.** Two numbers over
the corpus:

1. **Correct-binding rate** — share of pages where the proposed axis binding matches the known truth.
   Goes up.
2. **Silent-miss rate** — share of pages bound *wrongly* with **no** residue item and **no** low
   confidence. **Must be zero, and it dominates.** A design that raises (1) while raising (2) is worse
   than today, because today's defect is exactly a confident wrong reading.

   **Metric 2 scores REMEMBERED bindings as well as freshly proposed ones**, per §6.1 ruling 3. The
   corpus must therefore include re-import cases — the same page imported twice, and a *drifted*
   variant imported after a confirmation — so that a confirmed-wrong binding silently re-applying
   counts as a silent miss. Scoring only the first-contact proposal would leave this design's own
   worst failure outside the number that is supposed to dominate.

Neither number may be reported from a hand-built fixture, and per §6.3 both must either aggregate the
host-local journal deliberately or be labelled device-local on their face.

### 8.1 MEASURED — the corpus was built and run against unmodified code, 2026-09-27

**Owner instruction, verbatim:** *"instead, use the architect to devise 20-30 different potential
imports and then run them through the system as a test of what works, what breaks, and where to look
at what to fix."* **40 probe files** were built and run. Artifacts:

- `scripts/fixtures/make-preference-corpus.mjs` → `test/fixtures/preference-corpus/probes/` (40 files)
  and `test/fixtures/preference-corpus/manifest.json`
- `scripts/preferenceCorpusProbe.mjs` — the measurement harness (asserts nothing, on purpose)
- `docs/work/evidence/T282-preference-corpus-baseline.json` — the raw run
- `test/preferenceCorpusNames.test.js` — the §8.0 clause 4 control, 45 assertions, green

**Why this is evidence and not self-congratulation.** Red Hat's round-2 RISK 5 was that a corpus
measures adapter/generator agreement — same author, same round, both written to each other. That
objection applies to a corpus built *after* the adapters. Nothing has been built to these files: the
system under test is unmodified `main`-era code, and **nothing was fixed during the measurement**, so
the baseline is a baseline.

**The entry points.** Every probe enters at **file bytes**. `pref` = `runPreferenceSheetCli`
(`scripts/preferenceSheetCli.js`), which drives the same `inferPreferenceMapping` /
`parsePreferenceSheet` / `commitElectiveRun` chain the renderer's
`src/screens/elective/assignment/AssignmentPanel.jsx:254-263` drives. `sched` = `runIngestCli`
(`scripts/ingestCli.js`), which drives the same `partitionSchedulePages` → `extractEntities` →
`commitIngest` chain `ImportScreen.jsx` drives. No probe constructs a `parsed` object.

**The counts. CORRECTED IN ROUND 4 — see §11.1.** The owner has ruled this ticket is the **elective**
importer only. The seven probes that entered through `runIngestCli`, the **camp-schedule** path, are
out of scope and are excluded from T278's totals: P20, P21, P24, P25, P27, P28, P40. Their evidence
stands and is spun out separately.

| | in scope (33) | out of scope (7) |
|---|---|---|
| **(a) WORKS** — read correctly today | **9** — P01 P05 P08 P14 P15 P16 P17 P36 P37 | P25 P28 |
| **(b) BREAKS LOUDLY** — refused or errored | **17** — P03 P04 P07 P10 P11 P12 P19 P22 P23 P26 P29 P30 P31 P32 P33 P34 P39 | P21 P24 P27 |
| **(c) BREAKS SILENTLY** — committed, exit 0, data wrong or lost | **7** — P02 P06 P09 P13 P18 P35 P38 | P20 P40 |
| THREW | 0 | 0 |

**The ticket exists because of one instance of (c). There are seven in the elective path, plus one
cross-cutting loss affecting 15 of the 33.** Round 3's superseded totals were 11 / 20 / 9 over 40.

**Eight of the seventeen in-scope refusals blame the sheet for our own limitation** (P33, P12, P23,
P26, P19, P10, and two of the accurate-but-narrow ones). The three sharpest misleading messages —
P21, P24, P27 — turned out to be on the out-of-scope path; the *shapes* they measured (merged two-row
day header, transposed grid) remain live for an elective file and are re-pointed, not dropped
(§11.1).

#### (c) The silent misses, in full

| Probe | Shape | Observed | Where to look |
|---|---|---|---|
| **P38** | drifted re-import: `#3` renamed `Third Choice` | committed `ok=true`; **rank 3 dropped for all 13 campers** (26 prefs, not 39); no residue, no low confidence | `src/ingest/preferenceSheet.js:25` `RANK_HEADER`; `:58-60` `unmapped` reports only missing *roles*, never an unrecognised *column* |
| **P02** | 25-rank gradient, an activity repeated at two ranks | CLI printed `preferences: 200`; **the database holds 160**. `deriveElectivePreferenceId` keys on `(run_id, camper_id, occurrence_id, choice_id)` — **rank is not in the key**, so the second rank overwrites the first | `electron/ops/electiveDerivedIds.js` `deriveElectivePreferenceId`; `electron/ops/commitElectiveRun.js:318` |
| **P06** | partial id: one child on two rows, one row with an id | **two camper records for one child** (7 from 6), preferences split 3/3, nothing reported. `sameNameCampers` excludes it by design (§4.4) and nothing replaces it | `src/ingest/preferenceSheet.js:135-147` |
| **P09** | packed cell `"Archery, Ceramics, Woodworking"` | committed as **one** `elective_choices` label naming no real activity | `src/ingest/preferenceSheet.js:126-132` |
| **P13** | footer rows below the data | **3 phantom campers** — `Total Campers`, `Please Return`, `Camp Office Use Only` — each with preferences (`8`, `by June 1`). `skippedRows` empty | `src/ingest/preferenceSheet.js:83-91` |
| **P18** | swim opt-out checkbox + comments box | both columns committed nothing and **reported nothing**. **ROUND 4 sharpens this (§11.3):** the opt-out is not a homeless extra field — it is the **per-camper override of the fixed-event set**, and therefore an input to the coverage check. Dropping it silently makes the expected-cell count wrong for exactly the campers whose count differs from their division's | `src/ingest/preferenceSheet.js:38-63`; §11.3 |
| ~~**P20**~~ | ~~a camper's planner grid through the schedule importer~~ | **ROUND 4: SPUN OUT, NOT THIS TICKET (§11.1).** The evidence stands — it committed `ok=true` with 23 activities including `Lunch`, `Free Swim`, `Shabbat`, `Bunk Unity`, and one group named after the filename — but the defect lives in the camp-schedule import path | `src/ingest/scheduleShape.js`, `src/ingest/extractEntities.js` — raised separately |
| **P35** | a column headed `Group` holding an activity **track** | `divisionIndex` bound to it and `Sports Track` read as a division — then dropped (below) | `src/ingest/preferenceSheet.js:28` `DIVISION_HEADER` matches `/group/` |
| ~~**P40**~~ | ~~the planner as a plain-text grid~~ | **ROUND 4: SPUN OUT, NOT THIS TICKET (§11.1).** Evidence stands: it committed 23 malformed activities (`Hockey Music`, `Lunch Lunch`, `Period 3 Sailing`, `Rock Climbing Gaga`, `Tennis Shabbat`) and a group named after the joined header line, rather than refusing. Caveat noted in round 3: the probe's tab dialect may not be the one this reader expects | `src/ingest/textGrid.js` — raised separately |

**Cross-cutting, affecting 15 of the 33 in-scope probes: the division is parsed, previewed, and then
discarded.** `campers` has no `division` column (`electron/db/localDb.js:2677-2684`);
`parsePreferenceSheet` emits one per camper and the CLI reports it;
`commitElectiveRun.js:287-293` writes `camp_id`, `display_name`, `external_id`, `is_active` and
**drops `division` on the floor**, with no error and no residue. Found by probing for the column and
getting `no such column: division`.

#### (b) Loud, but is the message ACCURATE?

**Misleading refusals, listed because one sends a director to edit a file that is not wrong.** Rows
marked OUT OF SCOPE are on the camp-schedule path (§11.1) and are shown for the record only — their
*shapes* remain live for an elective file.

| Probe | Message | Why it misleads |
|---|---|---|
| **P33** | *"5 camper names appear on more than one row with no camper id to tell them apart… two children sharing a name would be merged"* | It is **one child with six legitimate per-cell blocks**. The message diagnoses an identity problem that does not exist and asks the director to fix it. **Round 2's widening of `hasContradictoryRanks` to carry `occurrence_id` does not help here**, because `describeElectiveRunRefusal` tests `sameNameCampers` *first* (`electron/ops/commitElectiveRun.js:37`) and `sameNameCampers` has no occurrence dimension at all |
| **P27** *(OUT OF SCOPE §11.1)* | *"expected either day-name columns or clock-time row labels, and found neither"* | The file has **both** — day names on header row 1, clock times on row 2. The message enumerates two accepted forms and refuses a file containing each |
| **P21** *(OUT OF SCOPE §11.1)* | same | `Monday`…`Friday` are in row 1, under a merged two-row header |
| **P24** *(OUT OF SCOPE §11.1)* | same | the days are present, as row labels — this is the transposed orientation |
| **P12** | *"does not look like a camper preference sheet — could not find: name, ranks"* | the header is in the file, on row 3. `rows[0]` is taken as the header unconditionally (`scripts/preferenceSheetCli.js:135`) |
| **P23** | same | the ranked fallback block, headed `#1`…`#5`, is in the file below the grid — only row 1 was read |
| **P26** | same | sheet 2 **is** a valid preference sheet. The reader is first-sheet-only by design (`scripts/preferenceSheetCli.js:63-71`) and never says so |
| **P19** | same | this is precisely a camper preference document — Kind 2 |
| **P10** | *"could not find: ranks"* | §4.1 rules an unordered set a legitimate shape. The message implies the sheet is malformed |

The other eleven refusals are accurate: P03, P04, P29, P30, P31, P32, P34 all say plainly that the
reader wants `#1`, `#2` headers and a camper-name column and did not find them; P07, P11, P39 name
the exact rows or columns; P22 correctly declines an offerings menu.

#### Where to look, ranked by probes unblocked

1. **`src/ingest/preferenceSheet.js:38-63` — `inferPreferenceMapping` must report columns it did not
   recognise, not only roles it could not fill.** Today `unmapped` lists missing *roles*; a column the
   reader does not understand is invisible. This one change, which teaches the reader **no new shape**,
   converts **P38, P18, P13, P35 and P02's over-count from silent to loud** — the largest
   silent→loud conversion available, and by §8's own rule that metric 2 dominates, the highest-leverage
   fix in the corpus. **Recommended first.**
2. `src/ingest/preferenceSheet.js:25` `RANK_HEADER` — its anchored `^#\s*(\d+)$` is the mechanism
   behind P03, P29, P30, P31, P32 and the P38 silent miss: 6 probes.
3. Header-row location — `scripts/preferenceSheetCli.js:135` / `preferenceSheet.js:78` both assume
   row 1: P12, P13, P23.
4. ~~Two-row / merged / transposed headers on the schedule path — P21, P24, P27~~ — **ROUND 4: OUT OF
   SCOPE** (§11.1). The camp-schedule reader is not this ticket. The three shapes return to this list
   the moment the elective adapter can be handed a grid.
5. `electron/ops/electiveDerivedIds.js` `deriveElectivePreferenceId` — P02; one probe, but it loses
   data on a sheet that otherwise reads correctly, and the reported count disagrees with the database.
6. `electron/ops/commitElectiveRun.js:287-293` + the `campers` schema — the division, 15 probes.
7. `src/ingest/preferenceSheet.js:26` `NAME_HEADER` — P04, P34.

#### What the evidence CONTRADICTS in this ADR and in round 2's rulings

Five, stated rather than quietly absorbed.

1. **§8's shape table guards a direction that is already safe, and the hole it misses is not this
   ticket's.** It lists class D as the danger — *"offerings menu (must be declined by the preference
   reader)"* — and P22 shows that is already handled. The unguarded direction is the opposite one: a
   camper's own planner grid is **accepted by the schedule importer** and committed as camp structure
   (P20). **ROUND 4: that hole is real and is spun out (§11.1)** — it lives in the camp-schedule path,
   which the owner has ruled out of T278. What survives for *this* ticket is the narrower point that
   §8's table pointed the guard at the direction that was already covered.
2. **The residue mechanism (§3.4) sits in the wrong half of the pipeline to catch four of the nine
   silent misses.** P02, P06, P18 and the division loss all happen **at or after commit**, inside
   `commitElectiveRun`, which this ADR treats as settled. A residue design that lives only in the
   reader would report none of them.
3. **Round 2's correction to `hasContradictoryRanks` is incomplete.** Widening the rank key with
   `occurrence_id` was right, but `describeElectiveRunRefusal` checks `sameNameCampers` **first**
   (`electron/ops/commitElectiveRun.js:37`) and that set carries no occurrence dimension, so P33 —
   one child, six legitimate per-cell blocks — is still refused as an identity collision. The round-2
   ruling widened one key and left its neighbour narrow.
4. **§4.4's ruling that same-name handling is "not a second defect" is half falsified.** The
   same-name *refusal* is sound (P07). Its complement is not: the PARTIAL-ID case it added as residue
   (P06) commits two records for one child with nothing reported, so the identity story is loud in one
   direction and silent in the other.
5. **§8's non-vacuity table cannot be executed in the order it implies.** Its first row — *"a
   correctly-read grid writes N rows with distinct non-null `occurrence_id`s"* — is presented as the
   test that proves the defect fixed. The corpus shows the preference reader refuses every grid at the
   header (P19, P23), so that test has no red-then-green available at the file-bytes entry until an
   adapter exists. It is still the right first test; it is not the right first *step*.

#### What this corpus CANNOT establish

**These are shapes we imagined.** That is a smaller limit than designing to one real file, and it is
the limit the owner's ruling deliberately accepts — but it is not zero, and a green corpus is not a
claim of agnosticism. Class H is absent by design and stays absent. Two further limits stated
plainly: the classification of a *committed* probe as correct or wrong is my reading of the rows, not
a mechanical check; and P40's text dialect may not be the one `parseTextGrid` expects.

**ROUND 6 — THE SHARPEST LIMIT, AND IT WAS MISSING (§13.6c). This corpus cannot exercise the
coordinate resolver at all.** `scripts/preferenceSheetCli.js:225-241` commits with `occurrences: []`,
and all 33 in-scope probes enter through it, so **no probe can produce a non-null `occurrence_id`** and
§11.2's checks 2 and 3 had no input on this path. The baseline is sound for the **column, label,
division and identity** resolvers and says **nothing** about the coordinate one. The harness plumbing
it needs — a template, an elective set, tiered groups — is added to T282's scope.

## 9. Open questions for the owner

1. **CLOSED — answered NO, 2026-09-27. Do not re-ask.** The question was: can we get one real Camp
   InTouch export. The owner declines, and his reasoning overrides my recommendation rather than
   merely refusing it — verbatim: *"you do not need a real import. that would explicitly defeat the
   purpose of system agnostic machine learning."* He is right about the mechanism: designing the
   reader against one real file makes that file the spec, and a reader tuned to one vendor's column
   arrangement is the thing D14 already retired.

   **What this changes.** Shape class H stops being *a gap we are waiting on the owner to fill* and
   becomes *a shape class we deliberately design without*. It is still never fabricated (§8's table
   is unchanged on that point), and §8.0 clause 3 — the handling rule for a real export held outside
   the repository — is now dead text rather than a live procedure.

   **What replaces it**, on the owner's instruction: *"instead, use the architect to devise 20-30
   different potential imports and then run them through the system as a test of what works, what
   breaks, and where to look at what to fix."* That measurement is §8.1, and it was run against
   unmodified code before anything was built to it.
2. **Is "infer, show, confirm, remember" what you meant by learning?** §6 rules it is, and rules out a
   trained model on the evidence available. If you meant something closer to a model that reads
   unfamiliar files on its own, say so — it is a different ADR with a different evidence bar, and I
   have deliberately not smuggled it in.
3. **Persisting the axis binding needs a table, and replicating it is a sync decision.** §5 amendment
   2 and §6. Two nods needed: that a per-camp remembered reading is wanted at all (the prior ADR
   recommended "not yet"), and that it **replicates** across the camp's devices rather than following
   the host-local precedent. **Per my brief I have not picked a schema version and must not.** For
   your information only: a peer session reports v79 as the next free version at the time of writing,
   which this ADR neither claims nor reserves — allocation is yours after the coordination the
   absorbed ADR's §10.1 describes. **And two technical sub-questions that must be settled in the same
   breath, because getting them wrong makes replication worse than not replicating:** what the
   record's id is **derived from** (a minted id produces two records and no conflict row —
   §6.3), and whether its natural key is registered with `detectUniqueFieldCollision`.
4. **Can the solver consume a preference with no rank, and must a cell choice outrank a fallback?**
   §4.1 and §4.2. This is a scheduling-engine product question — what the camp *means* — not a
   technical one.
5. **Where does the instructional-swim opt-out live?** §4.3. It is a parent-permission-bearing
   eligibility fact that changes which cells a camper must fill. It has no home in the model today and
   this ADR refuses to give it a wrong one.
6. **Carried over unanswered from the absorbed ADR** (§5): its §12 Q1 (`campers` and the
   `permissions.js` ENTITIES entry), Q3 (a camper in no group), Q4 (prevention-only for a
   false-positive camper row), Q5 (per-page declared kind granularity), Q6 (who allocates a schema
   version).
7. **NEW — do you want the last-resort escape hatch at all?** §0 premise 3. You closed the
   "reshape your file to our template" question and said *"we keep going over this"*, so I am not
   treating my own guardrails as permission to reopen it. The narrow thing I would keep: when the
   reader genuinely **cannot open or align a file at all** and has said so plainly, the director gets
   a pre-labelled grid rather than a blank screen — because their alternative in that moment is
   retyping the whole schedule. It would never appear beside "import", only after a stated failure,
   and every use would be logged as a reader failure so the reader keeps getting fixed. **If that is
   still on the wrong side of your ruling, say no and it is cut — nothing else in this design depends
   on it.**

**A note on camp identity in these documents, which is not a question but you should know it.** This
ADR no longer names the camp, its divisions, or any file path. But **a camp-identity exposure
pre-dates this work and spans earlier ADRs** — `docs/adr/2026-08-22-nested-schedules-electives-and-
events.md:29` and `docs/adr/2026-09-26-per-cell-elective-preferences.md:48` both name it on `main`.
Scrubbing only this file yields a green gate and a false sense of resolution. That exposure belongs
to **T120's public-history scope** and is being spun out separately; it is recorded here so the green
gate on this commit is not misread as the issue being closed.

## 10. Candidate premises rejected

Generated under two divergence passes — five isolated cognitive frames, then four isolated
premise-advocacy branches, each argued without sight of the others (`adhd`).

- **"Stop inferring entirely; the director declares kind AND layout."** Rejected in its maximal form:
  both past incidents ran through the *silent commit*, not the guess, so a refusal-on-mismatch design
  buys nothing the confirmation buys and costs an import the director cannot satisfy. Its load-bearing
  half is adopted (§3.3): kind declared, layout proposed.
- **"Learn nothing; make the loss loud and correction cheap."** Not rejected — **absorbed as stage 1**
  (§6, §8), on `decisionJournal.js`'s own sequencing argument. Rejected only as the *whole* answer,
  because a design that re-asks every June is not the improvement that was asked for.
- **"Hand the director our template and have them reshape their file."** Rejected as an import path by
  the owner's standing ruling, and independently by §1: the real answers live in a portal export the
  director does not author. Survives only as a last-resort hatch reachable *after* a stated reader
  failure, never as a menu option beside import.
- **A learned document-kind classifier.** Rejected as a trap: it answers a question the director
  already answered by choosing the import, it would score well on an easy task, and a perfect
  classifier moves the flattening defect by zero.
- **A per-camp column mapping as the unit of learning.** Rejected: it cannot represent a grid at all,
  and a column insertion re-keys it *silently*. It falls out of a resolved axis binding rather than
  being learned.
- **Running the transform as a hosted service.** Rejected on the local-first boundary (§3.2). The MCP/
  CLI *seam* is adopted; the network is not.
- **Picking one preference model.** Falsified by §1 — one camp, one season, two models.
- **Refusing a grid-shaped sheet read as flat.** Rejected: `commitElectiveRun.js:53-57` records the
  owner's ruling that a whole-run list with no cells is legitimate data. A refusal would reject real
  camps' real files. Residue, not refusal (§3.4).

## 11. ROUND 4 — owner scope correction, and the premise it overturns

### 11.1 Scope: this ticket is the ELECTIVE importer only

Owner ruling, close to verbatim: *"we are only touching electives. this is a schedule within a
schedule. it is nested… we are not touching 'import your camp schedule'. we are touching only
'import your elective schedule' here."*

**Consequence for §8.1.** Seven of the forty probes entered through `runIngestCli`
(`scripts/ingestCli.js`) — the **camp-schedule** import path — and are therefore **out of this
ticket's scope**: P20, P21, P24, P25, P27, P28, P40. They are removed from T278's totals. The
corrected counts over the **33 in-scope probes** are in §8.1.

**Removed, and where it went.** My round-3 report *led* with P20 — a camper's planner grid accepted
by the schedule importer and committed as camp structure, 23 activities including `Lunch` and
`Shabbat`, one group named after the filename. **The evidence stands and the defect is real; it is
simply not this ticket.** It is spun out separately, together with P40 (the text-grid path committing
malformed activity names) and the three misleading schedule-path refusals (P21, P24, P27).

**What must NOT be discarded with them.** P21, P24 and P27 were measuring *shapes* — a merged
two-row day header, a transposed grid, a two-row header carrying day names and clock times — and
those shapes are still live for an **elective** file. The probes measured them through the wrong
reader. They are re-pointed at the elective adapter when one exists, not deleted: `entry: 'sched'`
made them evidence about the camp-schedule reader by accident of harness wiring.

### 11.2 The premise that changes: the axes are a KNOWN SET, so binding is MATCHING, not inference

This ADR's §3.3 and §6 design a reader that **infers** an axis structure from an unknown grid and has
a director **confirm** it. **That premise is wrong, and the schema says so.** Verified by reading:

- `electron/db/schema.sql:1410-1417` — `elective_occurrences` carries `day_id` and `time_block_id`:
  references to **existing camp-schedule entities**, not values parsed from an elective file. Its own
  comment states the cells are *"re-derived from live template_slots on every generation (D6)"*.
- `electron/ops/commitElectiveRun.js:91-93` — the commit path already **takes** `occurrences`,
  `scheduleWeekId` and `scheduleTemplateId` from its caller.
- **And the decisive one, stronger than the correction I was handed.**
  `electron/db/schema.sql:574-584`: `template_slots.elective_set_id` set means *that cell is an
  elective cell*; `event_id` set means *that cell is an opaque event cell*; `activity_id` means an
  ordinary en-masse activity. The three are mutually exclusive and precedence-ordered
  (`MUTUALLY_EXCLUSIVE_FIELDS`, `electron/ops/projections.js`).

So the system does not merely know that this camp has Monday–Friday and periods 1–7. **It already
knows, per (day, block, group), which cells are elective, which are fixed events, and which are
en-masse activities** — the exact three-way distinction the owner's correction describes. §3.3's
free-form inference does not merely oversize the problem; it **reinvents a classification the
projection already holds.**

**What the binding actually is.** An injective map from the file's axis labels onto the camp's
existing `days` × `time_blocks`, restricted to the coordinates where
`template_slots.elective_set_id IS NOT NULL`. Not a discovered structure — a permutation over ids the
app already has.

**Three checks that are VERIFIABLE without asking the director.** This is the part that changes the
design's character, because a check is evidence and a confirmation is only a signature:

1. **Domain check.** A binding naming a day or a period this camp does not have is **provably wrong**.
   Refuse it; do not offer it.
2. **Elective-eligibility cross-check.** A cell bound to a coordinate that is **not** an elective cell
   is provably wrong — and the two possible causes are *distinguishable*, because the fixed event at
   that coordinate is known: if the cell's content matches the known fixed event there, the binding is
   right and the cell simply is not a preference (§11.3); if it names something else, the binding is
   wrong. **This is the check that converts a confident wrong reading into a caught one**, which is
   the entire defect this ADR was opened for.
3. **Coverage check.** The number of selectable cells is computable per camper from eligibility
   (§1 finding 4). A binding yielding a count that is not that camper's expected selectable count is
   suspect. **This is the numeric signal §8's metric 2 needs**, and it did not exist under the
   inference premise because there was nothing to compare against.

**The residual that still needs a human, and it is much smaller.** A binding that is a *valid*
permutation of real elective coordinates but the *wrong* one — Monday and Tuesday transposed where
both are elective in that period and both cells name plausible activities. Checks 1–3 all pass. That
case, and only that case, is what the director is asked about. Everything else is refusable or
verifiable.

**What this does to §6.** The "learning layer" loses most of its interesting surface on the axis
question, and that is a gain. It becomes: **match → verify mechanically → ask only about the residual
ambiguity → remember the confirmed permutation.** Two further consequences:

- **§6.1's confirmed-wrong-binding failure mode shrinks.** A remembered binding is re-run through
  checks 1–3 on every import, so a confirmed-wrong binding that becomes *invalid* (the camp changed
  its periods) is caught mechanically rather than silently re-applied. Only a confirmed-wrong binding
  that stays a valid permutation needs §6.1's read-back sentence and revoke act. Those stay; their
  load drops.
- **§1 finding 3 is answered outright.** Two divisions of one camp with 18 selectable cells by
  *different* geometries broke a reader keyed to a remembered geometry. A permutation over stable
  day/period **ids** is geometry-independent, so the finding stops being a hazard and becomes a
  property of the representation.

**Confidence, worked through rather than asserted.** It rises, but not uniformly, and the split
matters more than the direction:

- Confidence in the **axis-binding sub-design**: was low-to-medium, now **medium-high**. The reason is
  not optimism — it is that the problem changed class, from open-ended inference (unfalsifiable until
  a director looks) to constrained matching with three mechanical checks (falsifiable before anyone
  looks).
- Confidence that this design **covers the measured defects**: **unchanged.** Five of the seven
  in-scope silent misses — P02, P06, P13, P18, P35 — are **not axis-binding failures at all**, and
  knowing the axes does nothing for any of them. Neither does it help the reader *locate* the grid in
  the file (P12, P23: header-row position and first-sheet-only). Round 3's ranked fix list is
  therefore not superseded by this correction; it sits beside it.

I am stating that split deliberately, because the easy version of this report is "the premise changed
and confidence went up", and that would let a real gap ride on a true sentence.

### 11.3 Fixed and recurring events can never be electives — and the opt-out is the exception that proves it

Owner, close to verbatim: fixed and recurring events — Lunch, Instructional Swim, Free Swim, Shabbat,
Bunk Unity — are *"same time, every day, for either every group or some groups"* and can **never** be
an elective. **So a cell holding one is not a camper choice, and not an unreadable cell: it is a known
fixed event occupying that coordinate, and the app already knows which coordinates those are**
(`template_slots.event_id`, §11.2).

**Did this reclassify any probe?** I checked all 33 in-scope probes. **No.** Stated plainly rather
than dressed up: the probes whose fixed-event cells were misread (P20, P40) are exactly the two that
§11.1's scope ruling already removed, and the two in-scope grids carrying fixed-event cells (P19, P23)
are refused at the **header**, before any cell is read. The two rulings overlap almost completely in
their effect on the counts. What the ruling does change is what a *correct* read of P19 would be: **18
selectable cells of 35, not 35** — the other 17 were never asking to be read, so a reader that
reports them as unread residue would be crying wolf.

**One in-scope probe it sharpens rather than reclassifies: P18.** §1 finding 4 records that the swim
opt-out swaps a **fixed** row into a **selectable** one for that camper. So the opt-out column is not
a stray field this ADR has no home for — it is **the per-camper override of the fixed-event set**, and
therefore an input to check 3 (coverage). Dropping it silently is worse than §8.1 said: it does not
just lose a permission fact, it makes the coverage count wrong for exactly the campers whose count
differs from their division's.

### 11.4 Modelling note: electives may be almost the whole day

Owner: electives *"may also, however, be a camper's whole day with the exception of fixed and
recurring events."* **Any design that assumes electives are a small minority of cells is wrong.** The
concrete constraint: check 3's expected selectable count ranges from 1 to (all cells − fixed cells),
and must be **derived from the camp's elective-cell set**, never from a heuristic such as "a grid is
mostly fixed" or "electives are one or two periods". A same-number-different-geometry camp (§1
findings 2–3) is the mild case of this; a whole-day-elective division is the severe one.

## 12. ROUND 5 — the measured defects folded into the design, and the canonical record changed shape

Owner: *"why would we not be fixing this design now so that the 5 separate problems which arose are
folded in?"* He is right, and the framing that produced the gap was mine to own: §8.1 reported seven
in-scope silent misses and then left five of them outside the design, as if a design could be complete
while the evidence against it sat in a follow-up queue. A design written **before** the measurement
that is not revised **after** it is not a design, it is a hypothesis with a table attached.

**Second owner correction, applied throughout this section:** *"there is no one using this. stop
assuming that."* Pre-production — no live users, no real camp data, no paired device holding rows that
must keep matching. Every choice below is the shape I would pick building this today with nothing to
preserve. Where rounds 1–4 bent around data that does not exist, §12.7 names it.

### 12.0 The headline finding: RESOLVE is not one stage of four. It is the stage that closes all seven.

Working the seven silent misses individually produced one answer seven times. **Every one of them is
the elective importer accepting a value it could not resolve against something the app already
knows:**

| Silent miss | The unresolved thing |
|---|---|
| P38, P18 (comments) | an unrecognised **column** |
| P09, P13 | a choice **label** matching no activity in the camp's catalog |
| P35, division | a group/division **label** matching no camp group |
| P06 | an identity **fork** — one name, two derived ids |
| P02 | a **rank collision** — two ranks on one (camper, occurrence, choice) |

And §11.2's axis binding is the same shape a sixth time: a coordinate resolved against the camp's
existing elective cells. **So §3.1a under-specified the thing that matters.** It describes RESOLVE as
binding a (day, period) coordinate to an `occurrence_id`. The correct statement is broader and is now
normative:

> **RESOLVE is the stage where every value read out of a file is either matched to an entity the camp
> already has, or becomes residue. The elective importer never writes a value it could not resolve
> without saying so.** Five resolvers, one rule: columns → roles, labels → activities, division
> labels → groups, rows → camper identities, coordinates → elective cells.

That single sentence is what closes the seven. It is also why this is a *unified* design and not five
patches: one stage, one rule, five resolvers, and a Maker can check coverage by asking of any value
"which resolver owns this, and what happens when it misses?"

### 12.1 The canonical record CHANGED SHAPE — stated prominently, as instructed

**It did, in two places, and a schema version is now required (§12.6).**

1. **The camper gains `division_label` and a resolved `group_id`.** Round 1's record carried
   `division` as a parsed-and-displayed string with no storage. That was not a record, it was a
   preview field.
2. **The preference set gains a resolution step before it is counted.** Round 1's record was "what the
   file said". It is now "what the file said, after collision resolution" — because a record whose
   count disagrees with what gets written is not canonical (P02 reported 200, wrote 160).

Nothing else moves: no new table, no change to `elective_preferences`, no change to
`deriveElectivePreferenceId`'s key (§12.2b argues that on the merits).

### 12.2a CORRECTION TO MY OWN DESIGN — division had nowhere to live

**§3.1 specified a canonical record carrying a division and specified nowhere for it to go. That is a
design defect, not an incidental bug.** Verified: `campers` has `id, camp_id, display_name, group_id,
external_id, is_active` (`electron/db/schema.sql:1367-1374`) and no division.
`src/ingest/preferenceSheet.js:102` parses it, the CLI reports it, and
`electron/ops/commitElectiveRun.js:287-293` writes four fields and drops it. Fifteen of the 33
in-scope probes lose it.

**It is worse than a lost field, and this is the part that makes it a correction rather than a
ticket.** The owner has ruled that a stable camper identity is possible *precisely because* a
group/unit is attached. A design that discards the unit silently removes the evidence the identity
ruling rests on — so the same ADR both depends on the unit and throws it away.

**Decision.** Both halves, because they answer different questions:

- **`campers.group_id`** — resolved against the camp's **existing** `groups` by
  `recognitionKey('groups', label)`. This is the referential fact exports and the solver need. **A
  group is NEVER created from an elective file.** That is T224's lesson stated as a rule: a
  preference sheet's column headers once became camp groups. An unmatched label is residue, never a
  new row.
- **`campers.division_label TEXT`** (nullable, new) — the label **as written on the source file**.
  PROVENANCE, never an entity reference. It exists so that an unresolved label is *kept and shown*
  rather than lost, and so the director can see what we failed to match against what.

The pair is deliberate: `group_id` answers *which camp group is this child in*, `division_label`
answers *what did their file say*. Collapsing them into one field is how the unresolved case becomes
invisible again.

**Reconciled with §4.4, both plainly, because a Maker will otherwise conflate them:**

- **Division IS STORED** — on `campers`, as `division_label` plus a resolved `group_id`.
- **Division is NOT part of the identity key** — `deriveCamperId` keys on `(externalId ?? displayName)`
  and nothing else. Unchanged.
- **The way these fit together** is that the unit is *disambiguation evidence shown to a human*, not a
  key component. A child's division is renamed, respelled and outgrown between seasons, so keying on
  it makes the id unstable — §4.4's ruling stands for that reason. But when two rows name one child,
  the unit is exactly what lets the director say "those are two different kids." **So §4.4's ruling
  and the owner's identity ruling agree once the unit is stored and surfaced; they only appeared to
  conflict while it was being dropped.** Consequence: P07's refusal sentence must name each row's
  division alongside its row number. It does not today.

**D8 is satisfied deliberately, not bypassed.** `schema.sql:1361-1366` states `campers` is the whole
participant footprint and *"a future column here is an ADR-level change, not a field addition."* This
is that ADR-level change, and it is made on the record: `division_label` is not contact, medical,
date-of-birth, household or parent data, and adds no new category of personal information — it is the
camp's own grouping label, which `group_id` already implies.

### 12.2b CORRECTION TO MY OWN DESIGN — the preference identity loses data by construction

**Verified, and the finding is sharper than "rank is missing from the key."**
`deriveElectivePreferenceId(runId, camperId, occurrenceId, choiceId)`
(`electron/ops/electiveDerivedIds.js:348-356`) omits `rank`, and the function's own comment at
:344-351 **states the overwrite as an intended invariant**: *"a second whole-run ranking of the same
choice by the same camper overwrites the first rather than creating a second row."* So this is not an
oversight in the key. It is a documented invariant whose **consequence was never designed** — the
overwrite happens, nobody is told, and the number we print is the number we parsed rather than the
number we wrote. P02 printed 200 and stored 160.

**Decision: `rank` does NOT join the key. The collision becomes a resolved, reported event.** The
owner's correction removes every back-compat reason to leave the key alone, so I re-derived this from
scratch on solver semantics, and it lands in the same place for a different and better reason:

- If `rank` joined the key, a camper who names Swim at #1 and again at #14 yields **two rows with two
  priorities for the same (camper, occurrence, choice)**, and the solver must pick one. That is an
  arbitrary invisible decision about a real child's week — the exact failure class this ADR exists to
  eliminate. Putting rank in the key does not fix the loss; it converts a silent overwrite into a
  silent tiebreak.
- I could not construct a shape where two ranks for one choice within one occurrence is meaningful.
  Across occurrences it already works, because `occurrence_id` is in the key. Linked multi-period
  choices are ONE choice by `is_linked` (`schema.sql:1419-1428`), so they are not this case either.

**The rule, stated so it is not re-litigated:** the two collisions are asymmetric and get opposite
treatment.

| Collision | Resolvable by a rule? | Treatment |
|---|---|---|
| **same rank, two different choices** | No — nothing distinguishes them | **REFUSE** (today's `hasContradictoryRanks`, unchanged) |
| **same choice, two different ranks** | Yes — the better rank is unambiguously the camper's stronger statement | **ACCEPT: best (lowest) rank wins, and the dropped rank is RESIDUE** |

Refusal is not extended to the second case on purpose: refusing a 500-camper sheet because one child
listed an activity twice is the refuse-everything failure §3.1a already had to correct once.

**And the count is now defined as post-resolution.** The canonical record's `preferences` count, the
CLI's `counts.preferences`, and the number of rows written are **the same number by construction**.
P02's 200-vs-160 disagreement cannot recur, because there is only one number.

### 12.3 The remaining three, and the drift

**P06 — the identity fork.** One child on two rows, one row carrying an external id and one not:
two derived ids, two camper records, nothing reported. `sameNameCampers` **explicitly excludes this**
(`src/ingest/preferenceSheet.js:141-147` keeps only `ids.size === 1`), so the case §4.4 added as
residue has no reporter. **Design element:** the identity resolver reports **two** classes, not one.
(i) *Collapsed* — one name, one derived id, several rows → REFUSE, as today. (ii) *Forked* — one name,
several derived ids, at least one row lacking an external id → **RESIDUE**, listing each row's
`division_label` as the disambiguation evidence §12.2a just made available. Not a refusal: two
children who really do share a name and are distinguished by id are the *correct* reading of that
shape, and refusing it would punish the camps that export ids.

**P09 — the packed rank cell.** `"Archery, Ceramics, Woodworking"` committed as one choice label
naming no real activity. §4.1 ruled on an unordered *set in its own column* and said nothing about a
multi-value cell inside a *ranked* column. **Design element: the label resolver, against the camp's
activity catalog.** Whole cell matches a known activity → one choice. Whole cell matches nothing, but
splitting on a delimiter yields ≥2 tokens that each match a known activity → **residue, ask** (it is
genuinely ambiguous: a camp may have packed three alternatives into one rank, and an activity name may
legitimately contain a comma). Neither → **residue**. **Never mint a choice whose label matches no
activity in the catalog without saying so.**
*Degenerate case, stated because it is the common one on a first import:* a camp with an empty
activity catalog cannot match anything, so the resolver degrades to emitting **every distinct label as
unverified residue** for the director to read — loud and useless-looking, which is correct, rather than
quiet and wrong.

**P13 — phantom campers from footer rows.** `Total Campers`, `Please Return`,
`Camp Office Use Only` became campers holding preferences `8` and `by June 1`. **Closed by the same
label resolver:** a row whose rank cells resolve to **no** known activity is not a camper row; it
becomes a `skippedRows` entry naming the row number and what was on it. No new element — this is why
§12.0 calls RESOLVE the answer rather than five answers.

**P35 — `Group` column holding an activity track.** `DIVISION_HEADER` matches `/group/`, so
`Sports Track` was read as a division. **Closed by the group resolver (§12.2a):** `Sports Track`
matches no camp group, so it is stored verbatim in `division_label`, `group_id` stays null, and the
unmatched label is residue. The mis-binding is still made; it is no longer invisible.

**P38 — the drifted re-import.** Renaming `#3` → `Third Choice` silently dropped rank 3 for all 13
campers, `ok=true`, no residue. **Closed by the column resolver plus §11.2's checks:** (a) a column the
reader cannot assign a role to is reported — round 3's highest-leverage fix, and the reason it stays
first; (b) a **remembered** binding is re-run through the domain and coverage checks on every import,
so a binding that no longer matches the file is a binding-invalidation event that **re-asks** rather
than silently narrowing. A rank column present at confirmation time and absent now is exactly that.

### 12.4 TRACEABILITY — every in-scope silent miss, the design element, the test

Tests enter at **file bytes** and assert at the **database**. A test that constructs a `parsed` object
is not acceptable evidence for any row (T62, T197 round 1, the v78 fallback row).

| # | Silent miss | Design element that closes it | Test (file bytes → db) | Slice |
|---|---|---|---|---|
| 1 | **P02** two ranks, one choice: printed 200, wrote 160 | §12.2b — key unchanged; best-rank-wins; dropped rank is residue; **count defined as post-resolution** | import P02; assert `counts.preferences` **equals** `SELECT COUNT(*) FROM elective_preferences`, that the surviving row carries the **better** rank, and that a residue item names the dropped one | **T279** |
| 2 | **P06** identity fork: 2 records, 1 child, silent | §12.3 — identity resolver reports *forked* as well as *collapsed*; `division_label` is the evidence | import P06; assert 2 camper rows **and** a residue item naming both rows with their division labels; assert the run is **not** refused | **T279** |
| 3 | **P09** packed cell → one nonexistent choice | §12.3 — label resolver against the activity catalog; never mint an unmatched label silently | seed the catalog, import P09; assert **no** `elective_choices` row whose label matches no activity, and a residue item per ambiguous cell. Second case: empty catalog → every label listed as unverified | **T279** |
| 4 | **P13** 3 phantom campers from footer rows | §12.3 — same label resolver: a row resolving to no activity is not a camper row | import P13; assert exactly **8** camper rows and 3 `skippedRows` naming row numbers and contents | **T279** |
| 5 | **P18** opt-out + comments dropped silently | §12.0 column resolver (makes both **loud**) + §11.3 (the opt-out is the per-camper override of the fixed-event set, an input to the coverage check) | import P18; assert a residue item per unrecognised column, naming it. **Storage of the opt-out is a RESIDUAL — see §12.5** | **T279** (loud) / residual (stored) |
| 6 | **P35** `Group` column read as a division | §12.2a + **§13.5** — the DIVISION resolver, two targets in order (`groups`, then `tiers`); unmatched → `division_label` verbatim, `group_id` null, residue | import P35; assert `group_id IS NULL`, `division_label = 'Sports Track'`, and a residue item naming the unmatched label. **ROUND 6: `group_id IS NULL` being the success condition DISABLES check 3 for those campers — the test must also assert the page is counted UNMEASURED by metric 2, never passing (§13.5)** | **T279** |
| 7 | **P38** drift silently dropped rank 3 for 13 campers | §12.3 — column resolver **+** remembered-binding re-verification (§11.2 checks 1 and 3) | import P37, confirm the binding, import P38; assert the run is **not** committed on the stale binding — the director is re-asked, or a residue item names the column that vanished | **T281** (memory) / **T279** (the loud half) |
| — | **cross-cutting:** division parsed, previewed, dropped (15/33) | §12.2a — `campers.division_label` + resolved `group_id`, schema **v79** (§12.6) | import P01; assert `division_label` non-null for every camper and `group_id` resolved where a matching group exists | **T279** |

| 8 | **ROUND 6 / F1** a correctly-read grid is REFUSED for every camper — one name, one derived id, many rows (§13.1, reproduced by execution) | §13.1 — the identity resolver owns multiplicity; `sameNameCampers` gains the coordinate dimension: many rows for one name collide only when they share a coordinate, or when all lack one | import a per-cell planner for ONE camper with 18 distinct coordinates; assert 18 rows written, one camper, and the run **NOT refused**. Non-vacuity: the same name on two rows at the SAME coordinate is still refused | **T279** |

**Two axis-binding rows carried over from §8, restated here so the table is the single place to check
coverage:** a correctly-read grid writes N rows with distinct non-null `occurrence_id`s and is **not**
refused (**T279**); a confirmed-wrong binding is caught on read-back and is revocable (**T281**).

### 12.5 EXPLICIT RESIDUALS — silent misses NOT fully closed, and why

Listed rather than omitted, per the deliverable.

1. **P18's opt-out has no storage.** The design makes it **loud** (an unrecognised column is reported)
   and gives it a **role** (§11.3: the per-camper override of the fixed-event set, feeding the coverage
   check). It does **not** say where the fact is stored, because that is **§9 Q5, an open owner
   question**, and inventing a home for a parent-permission-bearing eligibility fact is exactly the
   wrong-model risk §4.3 refused. **So: closed as a silent miss, open as a modelled fact.** The
   distinction is real and I am not blurring it — a director will see that the column exists and was
   not read, which is a strictly better failure than today, and is not the same as supporting it.
2. **P09's ambiguous-cell resolution needs a director.** The resolver detects the ambiguity; it cannot
   settle it. A camp that packs alternatives into one rank cell must answer once. Not a defect —
   §4.1's ruling that a set must not be coerced into a rank means somebody has to say which it is.
3. **The three misleading schedule-path refusals (P21, P24, P27) are out of scope, and their SHAPES
   are not closed by anything here.** A merged two-row day header and a transposed grid are live
   shapes for an elective file. They are re-pointed at the elective adapter (§11.1), and until that
   adapter exists no design element in this ADR reads them. Stated so nobody reads §12.4 as covering
   grid *geometry* when it covers grid *resolution*.

### 12.6 Schema version: v79 is REQUIRED, taken, and announced

`campers.division_label TEXT` is a new nullable column, so this design needs a schema version. Per
the owner's correction, this is a design statement, not a request for permission to increment an
integer on an unused database.

**Taken: v79.** Coordination, by the method `feedback_authoritative_state_in_unpushed_worktrees`
requires — remote-only checks report false clean:

- `origin/main` and this worktree: `CURRENT_SCHEMA_VERSION = 78` (`electron/db/localDb.js:38`).
- **All 30+ local worktrees scanned**: the maximum is 78; none holds 79.
- No ticket or ADR reserves 79. `docs/adr/2026-09-26-schema-version-gate-before-merge.md:494`
  mentions v79 only to say that ADR does **not** need one. A peer session independently reported 79
  as next free, which agrees.

**What it costs: nothing to migrate.** A nullable `ALTER TABLE campers ADD COLUMN division_label TEXT`
on a pre-production database with no rows anywhere that must keep matching. Obligations that come with
the number, stated so a Maker inherits them: the migration is **ALTER ADD COLUMN, appended last**
(`campers` is the same column-order trap `special_days`/`elective_sets.is_reusable` hit —
`schema.sql:1036-1041`); `rollbackV79(db)` is written alongside it, per
`docs/adr/2026-09-26-schema-version-gate-before-merge.md`; the migration guard is
`>= 78 && < 79`, not a bare `< 79`; and the version constant must be **re-checked immediately before
merge**, because the check-to-merge window stays open while other sessions run.

~~**No other schema change.** `elective_preferences` is untouched~~ — **STRUCK IN ROUND 6 (§13.3).**
v79 carries **two** columns: `campers.division_label TEXT` and `elective_preferences.rank_kind TEXT`.
Without the second, §4.2's `rankKind` ruling is unimplementable and §9 Q4 has no input.

**ROUND 6 ADDITION to the obligation list (§13.4) — load-bearing and INVISIBLE if missed.**
`applyProjection` silently discards a field absent from its entity's allowlist
(`electron/ops/projections.js:1114`, `if (!projection.fields.includes(op.field)) return` — no error,
no log). So the same change MUST add `division_label` to `PROJECTIONS.campers.fields` (`:840-843`)
and `rank_kind` to `PROJECTIONS.elective_preferences.fields` (`:943-946`). Ship the ALTER and the
writer without these and nothing is populated anywhere, with a green gate.

`deriveElectivePreferenceId` keeps its shape; no index is relaxed, so `detectUniqueFieldCollision`
gains nothing to register. Version skew is **already governed** — mixed-version replication is out of
scope by an accepted, owner-decided ADR (`docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md`).

### 12.7 Where rounds 1–4 were bent around data that does not exist

Asked for, and there is a real pattern rather than a single slip.

**The pattern: rounds 1–4 reached for "report it as residue" wherever "store it" would have needed a
schema change.** Division is the clearest instance — the round-1 record carried it as a parsed field
with no home, and rather than saying "this needs a column" the design let it be a display value. That
is defensive shaping against a phantom: there is no data to protect and no migration to fear, so the
correct move was always to add the column. **Residue-instead-of-storage is the tell**, and it is worth
watching for elsewhere in this ADR.

Two specific instances, now reversed: §3.1's division field (§12.2a) and §8's implicit assumption that
this design needs no schema version, which was never argued — it was simply never questioned.

**Two things I checked and am NOT reversing**, because their reasoning is not back-compat:

- **§4.4's ruling that division must not join the derived id.** That is about identity *stability
  across seasons* — a division is renamed and outgrown — not about preserving existing ids. It stands
  on its own merits and §12.2a shows it was never in conflict with the owner's identity ruling.
- **§12.2b's decision to leave `deriveElectivePreferenceId` alone.** With the staleness caution
  removed I re-derived it from solver semantics and reached the same conclusion for a stronger reason.
  Had the only argument been "re-keying is expensive", it would have gone.

### 12.8 Confidence, and which round-2 rulings this falsifies

**Confidence in coverage of the measured defects rises from *unchanged* (round 4) to *high*.** The
reason is structural rather than optimistic: after §12.0, coverage is checkable without re-deriving
anything — every value has a named resolver and a named miss behaviour, so a gap shows up as a value
with no resolver. That is what §12.4 is for. **The axis-binding sub-design stays medium-high** (§11.2);
nothing this round touched it.

**What this round falsifies in my own earlier rulings:**

1. **Round 2's split of the program into stages 1–4 with the defects as later work is falsified.** The
   defects are not sequencing; they are coverage. §12.9 re-cuts the slices around them.
2. **Round 3's §8.1 framing of P02 as "one probe, low leverage" is falsified.** It is one probe and a
   *design defect in the canonical record's own accounting* — the printed count and the written count
   were different numbers. Probe counts were the wrong severity metric for it.
3. **Round 1's §3.1 is falsified as a canonical record.** A record with a field that has nowhere to go
   is a preview shape. §12.1 corrects it.
4. **§4.3's refusal to give the opt-out a home is NOT falsified**, and I want that on the record next
   to §12.5 residual 1, because the tempting move now is to invent one to make the table look complete.

### 12.9 Re-cut slices — one design, four observable predicates

Unified design, sliced implementation. Each slice keeps its own success predicate; §12.4's last column
says which slice closes which silent miss.

- **T279 — the ETL spine and ALL FIVE RESOLVERS, including schema v79.** Grows to carry six of the
  seven silent misses (P02, P06, P09, P13, P18-loud, P35) plus the cross-cutting division loss and
  P38's loud half. This is deliberately the big slice: the resolvers are one rule with five
  applications, and splitting them would ship a stage where some values are resolved and others are
  silently accepted — the current state, half-fixed, which is harder to reason about than either end.
- **T280 — the decision journal.** Unchanged in substance; it now records resolver misses and their
  outcomes, not only axis-binding questions, so §8's metrics are computable from it.
- **T281 — remembered binding.** Unchanged, plus the **re-verification on every import** that closes
  P38's remembered half (§11.2 checks 1 and 3 applied to a recalled binding, not only a fresh one).
- **T282 — corpus and metrics.** Unchanged in scope; the silent-miss baseline to beat is **7 of 33**,
  and the corpus already exists and is committed, so each slice above can be measured against the same
  33 probes rather than against new fixtures written to it.

## 13. ROUND 6 — five review findings, all accepted; one contested in part; one premise re-framed

**Every finding below was re-verified in this tree before being accepted.** F1 by *executing*
`parsePreferenceSheet` and `describeElectiveRunRefusal`, not by reading them. Four of five are
accepted outright, one (F4) is accepted in substance with its second half contested as already
governed. **F1 changes the design; F2 changes the conditions on §11.2's recommendation, not the
recommendation.**

**First, a correction in my own favour, recorded because the review found it and I had understated
it.** §11.2 leaned on `template_slots.elective_set_id`/`event_id`/`activity_id` as the camp's existing
three-way classification of every coordinate, and hedged because `schema.sql:574-584` says the
exclusivity is *"enforced by the (UI-driven) write path in a later slice."* **That comment is stale
v35 text.** `MUTUALLY_EXCLUSIVE_FIELDS.template_slots` (`electron/ops/projections.js:1070-1071`)
enforces it **today**, through `sanitizeMutuallyExclusiveRow`, as a precedence-ordered group. So the
classification is reliable enough to drive a **refusal**, not merely a proposal. §11.2's conclusion
holds more firmly than §11.2 claimed.

### 13.1 F1 [BLOCKER, ACCEPTED] — `sameNameCampers` refuses a correctly-read grid

**Reproduced by execution, not inference.** One camper, 18 planner cells read per-cell as 18 rows,
each with a distinct `occurrence_id`:

```
campers=1 prefs=18
sameNameCampers=1 [{"n":"<synthetic>","rows":18}]
REFUSAL: 1 camper name appears on more than one row with no camper id to tell them apart:
         <synthetic> (rows 2, 3, …, 19). Resolve these before importing —
         two children sharing a name would be merged into one record.
```

`src/ingest/preferenceSheet.js:126-137` keeps every name with `rowNumbers.length > 1 && ids.size === 1`;
`electron/ops/commitElectiveRun.js:36-44` tests `sameNameCampers` **before** `hasContradictoryRanks`.
So **§12.4's row "a correctly-read grid writes N rows with distinct non-null `occurrence_id`s and is
NOT refused" and T279's own `archive_when` were unachievable as written.**

**This is the refuse-everything class §3.1a corrected in round 2, surviving one gate to the left of the
one I fixed** — and I named it myself in §8.1 contradiction 3, then left it out of both §12.4 and
§12.5. That omission is precisely the completeness claim the traceability table exists to make, so the
table was making a claim it had not earned. Recorded rather than quietly patched, per the D14/D4
convention.

**Decision — the fifth resolver (rows → identities) explicitly owns multiplicity, and
`sameNameCampers` gains the coordinate dimension.** This is the *same widening* round 2 applied to
`hasContradictoryRanks`, applied to its neighbour, which is why round 2's correction was incomplete
(§8.1 contradiction 3, now closed):

> One name collapsing to one derived id across many rows is a **collision** only if those rows
> occupy the **same** coordinate — or if every one of them lacks a coordinate (the whole-run shape,
> where many rows for one name can only mean many rows for one child). Rows carrying **distinct**
> `occurrence_id`s are **one camper's per-cell answers**, which is the correct reading of a grid and
> must not be refused.

An absent `occurrence_id` collapses to the same empty component for every whole-run row, so T226's
original behaviour is preserved exactly for that shape — a widening, not a replacement. Added to
§12.4 as row 8, and T279's `archive_when` is corrected.

### 13.2 F2 [HIGH, ACCEPTED — the premise survives with conditions; the framing does not]

Three verified facts, each fatal to §11.2's **unconditional** framing:

1. **No template exists at binding time.** `src/screens/elective/assignment/AssignmentPanel.jsx:242-270`
   runs file → `inferPreferenceMapping` → `confirmMapping` → `parsePreferenceSheet` with no template;
   `chooseTemplateAndSolve` is at :281, strictly after.
2. **The coordinate set is PER-TEMPLATE and two templates may disagree.** `deriveOccurrences` groups
   by `template_id` and returns `.templates[chosenTemplateId]`; neither candidate route is canonical
   (CLAUDE.md).
3. **It can be EMPTY, and that state is rendered.** `AssignmentPanel.jsx:447` handles
   `candidateTemplateIds.length === 0` with *"This set isn't on a schedule yet."* **And the ordering
   this breaks is the natural one** — a director collecting family forms in spring, before the
   schedule is built.

**§11.2 contradicted §3.1, and §11.2 is the section that yields.** §3.1 already rules the canonical
binding **template-agnostic**: *"A binding names a coordinate (day, period), never an `occurrence_id`;
the caller resolves the coordinate against `deriveOccurrences` at solve time."* §11.2 then wrote the
three checks as if they all ran at binding time. That was my error, and §3.1 was right first.

**Decision — the checks are STAGED, and two of them are conditional:**

| Check | Runs | Needs a template? | Unavailable when |
|---|---|---|---|
| **1 — domain** (a named day/period exists at this camp) | **parse/bind time** | **No** — `days` and `time_blocks` are camp-scoped (`schema.sql:722-730`), not template-scoped | never |
| **2 — elective-eligibility** (this coordinate is an elective cell) | **solve time**, against **the template being solved** | Yes | no template chosen, or the set is unplaced |
| **3 — coverage** (expected selectable-cell count per camper) | **solve time**, same template | Yes | as check 2, **and** per §13.5 for untiered campers |

**The empty-coordinate-set paragraph, in the same voice §12.3 used for the empty activity catalog.**
When the elective set is not yet on a schedule, checks 2 and 3 are **UNAVAILABLE, not failing**.
Reading `zero elective coordinates` as "every cell is provably wrong" would refuse the spring
collection of family forms, which is the *normal* order of work. So: the bindings are parsed, resolved
as far as check 1 allows, and **stored with their coordinates intact**; checks 2 and 3 are deferred
and surfaced as a standing residue — *"these preferences cannot be checked against a schedule yet"* —
which **clears by itself** once the set is placed. Deferral is visible; it is never silence.

**The disagreement rule.** A coordinate that is an elective cell under one candidate template and not
under the other is **not a refusal and not a defect in the child's preferences.** Checks 2 and 3 are
scoped to the template being solved, and a cross-template disagreement is **information about the two
schedules**, reported as a per-template residue against the solve that surfaced it. Any other rule
would require designating one route canonical, which CLAUDE.md forbids and §3.1 already refused.

**Does F2 change the recommendation?** No — it changes its conditions. Matching against a known set is
still strictly better than free-form inference, and check 1 alone (which needs no template) already
catches the class of wrong reading that opened this ADR. What F2 removes is the claim that all three
checks are always available. **Confidence in the axis-binding sub-design drops from medium-high back to
medium** — not because the approach is wrong, but because two of its three checks are conditional on a
state the natural workflow does not guarantee, and the deferral path is now load-bearing.

### 13.3 F3 [HIGH, ACCEPTED, both halves + the compounding case] — `rankKind`, and a stale record block

**This is §12.7's own diagnosed pattern recurring one section from where I diagnosed it**, which is the
part worth saying plainly: §4.2 ruled the binding needs a companion `rankKind`;
`schema.sql:1473-1480` has no such column; and §12.6 then foreclosed adding one — *"No other schema
change. `elective_preferences` is untouched"* — while I was already taking a version with nothing to
migrate. Residue-instead-of-storage, again, three sections after I named it as the tell.

**Decision: `elective_preferences.rank_kind TEXT` joins v79.** §12.6's "no other schema change"
sentence is **struck**. Without it, §4.2's ruling is unimplementable and §9 Q4's solver weighting has
no input: the field distinguishing a cell-choice from a whole-run fallback would never be written.
Nullable, ALTER ADD COLUMN, nothing to migrate.

**§3.1's literal record block is STALE and is replaced, not merely banner-flagged** — a Maker copies
the block, not the banner. The round-6 shape:

```
{ camperName, camperExternalId|null,
  divisionLabel|null,                 // §12.2a — provenance, verbatim
  dayName|null, periodLabel|null,     // nullable: the "premise 6 is dead" property
  choiceLabel, rank|null, rankKind,   // §4.1 null rank; §4.2 kind, persisted at v79
  source: { page, row, column } }
```
…and the record SET carries a **post-resolution** preference count (§12.1) plus the residue ledger.

**The compounding case F3 raises, which had no defined winner: `null` vs `2` on one derived id.** §4.1
mandates `rank: null` for an unordered set; §12.2b's asymmetry table is defined over ranks that exist.
A third row, added to that table:

| Collision | Resolvable by a rule? | Treatment |
|---|---|---|
| same rank, two different choices | No | **REFUSE** (unchanged) |
| same choice, two different ranks | Yes — the better rank is the stronger statement | **best (lowest) rank wins; the drop is residue** |
| **same choice, one ranked and one unranked (`null`)** | **Yes — an explicit rank is strictly more information than its absence** | **the RANKED row wins; residue names the discarded unranked one AND the `rank_kind` disagreement, because a file that said the same thing twice in two different languages is telling us something about itself** |

Two unranked rows for one derived id are identical and are a no-op.

### 13.4 F4 [MEDIUM — obligation ACCEPTED, skew half CONTESTED as already governed]

**Accepted, and it is a genuine gap in §12.6's obligation list.** `PROJECTIONS.campers.fields` is an
explicit allowlist — `['camp_id','display_name','group_id','external_id','is_active']`
(`electron/ops/projections.js:840-843`) — and `applyProjection` does `if
(!projection.fields.includes(op.field)) return` (`:1114`): **an unknown field is silently discarded,
no error, no log.** So a Maker shipping the ALTER and the writer but not the allowlist entry populates
nothing, anywhere, and the gate stays green. §12.6 is corrected to require, as part of the same
change and not a follow-up:

- `PROJECTIONS.campers.fields` gains **`division_label`**.
- `PROJECTIONS.elective_preferences.fields` gains **`rank_kind`** — the same trap, found by applying
  F4's own reasoning to F3's column: that allowlist is
  `['run_id','camper_id','occurrence_id','choice_id','rank']` (`:943-946`).

**Contested, with evidence: the version-skew half is already ruled and does not need a new ruling
here.** `docs/adr/2026-09-18-mixed-version-replication-out-of-scope.md` is **accepted, normative,
owner-decided**: a camp's devices run one build. So "a v78 device silently drops every
`division_label` write" is a known, governed consequence of an out-of-scope configuration, not an open
question for this ADR — and `authGate.test.js:77`'s observability-only `schemaVersion` is the
*implementation* of that ruling, not a gap in it. I am not invoking pre-production to wave it away;
I am pointing at the ADR that decided it. **What I do accept** is that the obligation list must say
this, so a Maker does not rediscover it: the projection entry is load-bearing, and its absence is
invisible rather than loud.

### 13.5 F5 [MEDIUM, ACCEPTED] — division is a TIER here, and that makes check 3 conditional

Verified: `DIVISION_HEADER = /division|bunk|group|unit|edah/i` (`preferenceSheet.js:28`) conflates four
granularities; the division concept in this codebase is **`tiers`** (`schema.sql:499-505`); and
`deriveOccurrences` keys occurrences on `group.tier_id`, emitting `UNTIERED_GROUP` and **skipping the
slot** when it is absent (`:33-40`). So a file whose Division column holds `Grades 7-8` matches no
group, `group_id` is NULL for every camper — and **§12.4 row 6 asserted `group_id IS NULL` as the
SUCCESS condition without noting that it disables the numeric signal §8 metric 2 depends on.** That is
a real hole in the traceability table's own logic.

**Decision, two parts.**

1. **The group resolver becomes the DIVISION resolver, with two target sets in order: `groups`, then
   `tiers`.** A `groups` match sets `group_id` (and yields the tier transitively). A `tiers` match sets
   **nothing referential** and is reported as residue naming the tier it matched, so the director can
   assign groups. **`campers.tier_id` is deliberately NOT added**, even though I am already taking a
   version: `groups.tier_id` is the single path from a camper to a tier, and a second path is a second
   thing to disagree. That is the one place in this round where I am declining a column on the merits
   rather than out of caution — and it is the opposite of §12.7's diagnosed pattern, so it is worth
   distinguishing.
2. **Check 3 is UNAVAILABLE for a camper whose division resolved to neither a group nor a tier, and
   metric 2 must not score those pages as passing.** Stated as the metric's construction:

   > **Metric 2 (silent-miss rate) is published over the pages where check 3 was AVAILABLE, plus an
   > explicit count of UNMEASURED pages.** A page whose campers are untiered is unmeasured, never
   > passing. A design that raised the measured rate by pushing pages into the unmeasured bucket would
   > be visible as a rising unmeasured count, which is the whole point of reporting it beside the
   > number rather than inside it.

This preserves metric 2's "must be zero" property, which a silent denominator would have destroyed.

### 13.6 The three lower findings

**(a) §6.1 ruling 2's season expiry is unimplementable and is REPLACED.** `grep -c season
electron/db/schema.sql` returns **0**. There is no season concept; `cohorts.session_week_start/_end`
(`schema.sql:670-678`) is a session window, not a season, and dating a binding's expiry to a calendar
was the wrong instinct anyway. **Replacement ruling: a remembered binding expires on a change to the
camp's elective COORDINATE SET** — the same input checks 1 and 3 already consume. That is both
implementable today and more correct: what should force re-confirmation is the schedule changing
shape, not a date passing. T281's ship-gate is corrected accordingly.

**(b) The label resolver's second target set — accepted, and folded rather than added.** §11.2 check 2
distinguishes a wrong binding from a fixed-event cell by *"the cell's content matches the known fixed
event there"*, which is a label→**event** resolution that none of §12.0's five resolvers owned.
Applying my own coverage question to my own design is what surfaced it. **It folds into the label
resolver as a second target**: a rank-cell label resolves against `{the camp's activities} ∪ {the fixed
event at that coordinate}`. **The near-miss case is named explicitly**, because it is the near-match
defect wearing a new name: `Instructional Swim` vs `Swim (Instructional)` matches neither target
exactly, so it is **residue**, never a silent match and never a silent refusal. Same discipline as
`nearDuplicateNames`. Five resolvers, one of which has two target sets.

**(c) THE CORPUS CANNOT EXERCISE THE COORDINATE RESOLVER — accepted, and it is the sharpest limit on
§8.1's evidence.** `scripts/preferenceSheetCli.js:225-241` commits with `occurrences: []` and
`assignments: []` and says so. All 33 in-scope probes enter through it, so **no probe can produce a
non-null `occurrence_id`**, and §11.2 checks 2 and 3 had no input on that path. Consequences, stated
rather than absorbed:

- §8.1's measured baseline is sound for what it measured — the **column, label, division and identity**
  resolvers — and says **nothing** about the coordinate resolver. §8.1's "what this corpus cannot
  establish" is extended to say so.
- §12.4's claim that its tests "enter at file bytes and assert at the database" is true only once the
  harness can supply a template, an elective set and tiered groups. **That plumbing is added to
  T282's scope** with its own predicate; without it, rows 1, 2, 7 and the two carried-over
  axis-binding rows cannot be written as specified.

### 13.7 What round 6 changes overall

| | Before round 6 | After |
|---|---|---|
| Schema v79 | 1 column (`campers.division_label`) | **2** — plus `elective_preferences.rank_kind` (§13.3) |
| Projection allowlists | not mentioned | **required, same change** — `campers` + `elective_preferences` (§13.4) |
| §11.2 checks | three, always available | **staged**: 1 at parse time, 2 and 3 at solve time, conditional (§13.2, §13.5) |
| Resolvers | five | five, one with **two target sets** (§13.6b) |
| §12.4 rows | 7 + cross-cutting + 2 carried | **+1** (F1 grid multiplicity), row 6 annotated (§13.5) |
| Axis-binding confidence | medium-high | **medium** — two of three checks are conditional |
| Coverage confidence | high | **medium-high** — F1 was a gap in the table itself |

**Both confidence figures go DOWN this round**, and that is the honest reading: the review found a
blocker the traceability table was built to prevent, and found that a premise I had called verified was
verified for the wrong stage of the pipeline. The design is better; my estimate of it was too high.


## 14. ROUND 7 — two owner rulings from the first implementation round

Both came out of implementation reporting a consequence honestly and the owner rejecting the
conclusion drawn from it. Recorded here rather than in the ticket because the first is a standing rule
that outlives T279 entirely.

### 14.1 STANDING RULE — at the machine seam, ACCEPT AND REPORT. Never refuse a readable file.

Owner, 2026-09-27: *"imagine that someone is using the cli or the mcp — the point would be to have
your AI talk to the software. that bridge makes everything about our life easier. how could we write
software that says no to someone?"*

**Ruling: the CLI (`scripts/preferenceSheetCli.js`, `scripts/ingestCli.js`) and the MCP tools
(`scripts/mcp/tools.js`) must never refuse a file they can read.** A refusal at that seam is not a
safety property — it is the bridge failing. The whole point of the machine interface is that an agent
can drive this software on a director's behalf, and an agent cannot argue with a refusal the way a
human can.

**This generalises a ruling already on the record** rather than introducing a new principle. The owner
had already ruled, at `commitElectiveRun.js:53-57`, *"we are reading someone's data. we are not
choosing how they import it"*, and round 5 of this ADR applied it to one case (a whole-run list with no
`occurrence_id`). §14.1 states the general form: **ACCEPT AND REPORT is the only acceptable shape at
the machine seam.** Residue (§3.4) is what makes that safe — the loud half is the reason accepting is
not the same as pretending.

**What this rule does NOT license**, stated because it would otherwise read as "never refuse
anything":

- A genuine **collision** still refuses, because accepting it would mean inventing an answer. Two
  children sharing a name with nothing to tell them apart, or one camper holding one rank on two
  different choices, are not readable files with a reported caveat — they are files with two possible
  readings and no evidence for either. §12.2b's asymmetry table stands.
- It is not licence to **write a value that was not resolved**. §12.0 is unchanged: accept the file,
  and say what could not be resolved. Accepting a file and silently guessing at its contents is the
  defect this whole ADR exists to remove, and "never refuse" must not be read as permission to
  commit it.

The distinction is between *"this app does not support your file"* (forbidden at the machine seam) and
*"this file is ambiguous and I cannot choose for you"* (still correct). The first is a limitation the
bridge should absorb; the second is a question only a human can answer.

#### §14.1 IS NOT SATISFIED TODAY, and here is exactly how far off it is

Stated with the measurement rather than as an aspiration, because a standing rule recorded without its
gap list reads as a rule already kept. T279 round 2 **stopped adding** a refusal; it did not remove the
ones already there. Measured against the corpus (`node scripts/preferenceCorpusProbe.mjs
--seed-catalog`), of 15 refusals on the preference path **14 violate §14.1** and one does not:

| Refusal | Probes | Verdict |
|---|---|---|
| *"does not look like a camper preference sheet — could not find: name/ranks"* | P03, P04, P12, P19, P22, P23, P26, P29, P30, P31, P32, P34 | **VIOLATES.** Every one is a readable file in a shape no adapter exists for: prose rank headers, a header that is not row 1, a planner grid, an offerings menu, tidy/long form, activities-as-columns, split name columns. |
| *"header lists rank #N more than once"* | P11 | **VIOLATES.** A duplicate rank header is resolvable — it is the `unordered-set` reading (§4.1), a tie among equals — and is being refused instead of read. |
| *"has no rows under its header"* | P39 | Benign. There is no data to accept; this is a description, not a refusal of content. |
| *"camper name appears on more than one row with no camper id"* | P07 | **CORRECT and stays.** Genuine ambiguity with no evidence for either reading — the second category above. |

So §14.1's real cost is **the adapters**, and that is the honest sizing: the rule is satisfied by
teaching the reader more shapes and reporting what it could not bind, not by deleting refusal
statements. Deleting them without an adapter would produce the far worse failure of committing a file
the reader does not understand — T224 exactly. **This is a program, not a patch**, and it is the
`offerings-menu` / elective-adapter work §11.1 and §12.5 residual 3 already scope. What round 2 adds is
the *rule* those slices are measured against, plus the number they have to move: **14 to 0.**

**MEASURED AFTER T285 (2026-09-27): the count is 0.** All six adapter slices ran
(`docs/work/tickets/T285-preference-shape-adapters.md`), and every row of the table above is closed
except the two that were never violations: P07 stays refused as the genuine ambiguity this rule's
second category preserves, and P39 is an empty file. The corpus now reports **no probe in the
BREAKS SILENTLY bucket at all**.

Two things §14.1 turned out to need that this section did not anticipate, both recorded in T285's
outcome section: an offerings menu and a filled planner are the same geometry, so the rule is
satisfied WITHOUT classifying the kind — by the kind-agnostic fact that a page naming no camper
cannot hold a camper preference; and "never refuse" had to be paired with a SECOND accuracy
obligation, because the first draft of each new adapter characterised what it skipped wrongly
(a planner grid called "a title or a season line", an unreadable sheet called "no camper name
column" when it had one). **Accepting a file and then describing it wrongly is not an improvement
on refusing it**, which is the sharpest lesson of the program and belongs beside the rule.



### 14.1a STANDING RULE — we do not question the shape data arrives in. We LAND it, then RESOLVE it.

Owner, 2026-09-27, after T285 escalated a shape question that should never have reached him:

> *"the grid is the camper's own sheet, they fill it out and turn it into campminder. again, this does
> not fucking matter. our job is not to question what shape the data comes in. we are a lake, the
> warehouse, and the pipeline."*

**Ruling: a question about what a document's shape MEANS is answered by LANDING THE DATA and REPORTING
THE UNCERTAINTY — never by refusing, never by dropping the unreadable half, and never by escalating the
shape question to the owner.** The only legitimate refusal remains the one that would merge two real
children (P07).

This is §14.1 (never refuse at the machine seam) carried one step further, and the step matters: §14.1
stopped us saying *no*, and this stops us saying *nothing*. Accepting a file and then declining to read
half of it is the same loss as refusing it, with better manners.

**The product fact that resolved it, which no prior round had.** A planner grid has no camper-name
column because **it does not need one** — it is ONE CAMPER'S OWN SHEET, filled in and submitted, and
the identity comes from the **submission**, not the page. So "no camper is named" means **one subject,
not zero**.

**What that overturns, named plainly because it was my own reasoning.** Slices E and F concluded that
"neither page names a camper, so neither can hold a camper preference." That sentence is true of an
offerings menu and false of a camper's planner, and it cannot tell them apart — so it read only P23's
ranked block and reported its grid as unattributable. **That is this ADR's own defect for the third
time in a new costume: the importer discarding a child's answer because it could not place it.** The
pattern is worth naming as a pattern, since it has now recurred three times: §12.2b's key scoped a
child's statement to a schedule's identity; round 2 residued the resulting loss instead of storing the
coordinate; slice F reported a loss instead of landing the subject. **Every time, the tell was the same
— reporting something instead of storing it.** §12.7 diagnosed exactly this and it still recurred
twice more after the diagnosis.

**The design this forces.**

1. **A page with no camper-name column is ONE SUBJECT.** Every filled cell becomes a per-cell
   preference carrying its coordinate, exactly as a named per-cell sheet would.
2. **Identity resolves in order, and NEVER blocks the data landing:** an explicit camper from the
   caller (CLI/MCP argument, or the import screen's selection) → a camper named on the page → the
   filename → otherwise an **unattributed subject**. An unattributed subject is a **first-class
   outcome, not a failure**.
3. **Attribution is residue, not refusal**, and resolvable later without re-import — the same shape as
   the coordinate-before-template case in §14.2.
4. **`campers.is_unattributed` joins v79** (its fifth column). The flag is not decoration: residue
   reports the missing identity at import time, but **residue is not persisted**, and "land it, then
   resolve it" is only true if the thing to resolve can be FOUND afterwards.

**Constraint 1 survives, and had to be re-founded.** An offerings menu must still write zero
preferences (T224: a selection workbook once committed its column headers as 33 groups and again as 33
tiers). But it can no longer be separated by "no camper is named", because that is precisely what a
camper's own sheet looks like. **It is separated on ARITY instead: a menu supplies SEVERAL activities
per (day, period); a filled planner records ONE choice.** That is a statement about the data's arity,
which is checkable, rather than about what the document means, which §3.3 rightly says no shape
inference can reach. Measured on the corpus: P22 has 2 columns per day (an A/B sub-header), P19 and
P23 have 1.

**And a second obligation that came out of this program, stated here because it is the sharpest thing
learned:** the first draft of every new adapter described what it skipped WRONGLY — a planner grid
called "a title or a season line", an unreadable sheet called "no camper name column" when it had
one, an unread-table residue left firing over rows that were in fact read. **Accepting a file and then
describing it wrongly is not an improvement on refusing it.** "Never refuse" and "never mischaracterise"
are one rule with two halves.

### 14.2 The coordinate is STORED, and §12.2b's key was wrong about which fact it was scoping

**The report that triggered this.** Round 1 implemented §12.2b's collision key literally, as
`deriveElectivePreferenceId`'s own key — `(camper_id, occurrence_id, choice_id)` — and then reported
the consequence: *"until a caller resolves a coordinate to an occurrence_id, two DIFFERENT cells
naming the SAME activity collapse onto one row. The drop is residued rather than silent, which is the
honest behaviour available at this layer."* Measured on P33: 15 rows written, 75 dropped.

**The owner's reading, which is correct and which the design had missed:** that sentence describes the
importer **discarding a camper's answer** — "Archery, Monday period 3" — because it could not yet
express it as a row. **That is the defect this ADR was opened for, happening inside the fix for it.**
Residuing a loss does not stop it being a loss; §3.4's loud half exists for values the app genuinely
cannot resolve, not as a receipt for data it chose to drop.

**The error, named precisely.** §12.2b reasoned about scope as though `occurrence_id` were the only
scope dimension, and concluded that rank must not join the key — which is still right. What it missed
is that a preference is scoped by **two different kinds of fact**, and they are not interchangeable:

| Fact | What it is about | When it is true |
|---|---|---|
| **coordinate** (day label, period label, as written) | what the **CHILD** asked for | the moment the sheet is read |
| **occurrence_id** | a cell of **ONE candidate schedule** | only once a template exists |

Keying a child's statement on a schedule's identity makes the child's statement unstorable until a
schedule exists. **§3.1 had this right and storage never followed it** — it says the binding "names a
coordinate (day, period), never an `occurrence_id`; the caller resolves the coordinate against
`deriveOccurrences` at solve time." The canonical record was correct from round 1; the STORAGE was
never made to match it, and §12.6's "no other schema change" foreclosed the column that would have.
**That is §12.7's own diagnosed pattern — residue-instead-of-storage — for the third time in this
document.** It is worth stating plainly that the tell held: every time this design reported something
as residue where storing it needed a column, the storage was the right answer.

**Decision, three parts.**

1. **`elective_preferences` carries the coordinate as read** — `coordinate_day_label` and
   `coordinate_period_label`, both nullable, at v79 (§12.6's column list grows to four). Stored
   VERBATIM: the derived id canonicalizes for keying, but these columns are provenance and a director
   has to recognise their own sheet in them. `occurrence_id` is unchanged — still nullable, still
   resolved later by the caller.
2. **`deriveElectivePreferenceId` gains a THIRD arm, and a per-kind version.** The arms, in
   descending strength of scope: `occ` (an occurrence), `at` (a coordinate), `all` (neither, the
   whole-run fallback). Two cells therefore derive two ids **with no template in sight**, which is the
   entire point. The prefix version becomes `epref2:` via a new `PREFERENCE_V` rather than a bump of
   the module-wide `V`: `V` is shared by eight id kinds including `camper${V}`, and re-keying every
   camper id — referenced by assignments and attendance — is not proportionate to a change in one id's
   scope arms. The owner's instruction was that the shape change must be **visible** rather than
   drifting under an unbumped version, which a per-kind version satisfies without the blast radius.
   Pre-production: nothing live to re-key, and a developer's local `shoresh-dev` database holding
   `epref1:` rows will not match freshly-derived ids — stated rather than glossed, per this module's
   own warning about exactly that case.
3. **Coordinate RESOLUTION does not move.** The eligibility and coverage checks stay solve-time and
   template-scoped, exactly where §13.2 put them. This change only stops the coordinate being thrown
   away before those checks can ever run. A file imported in spring, before any schedule exists,
   round-trips its coordinates intact and becomes resolvable later **without being re-imported** —
   which is the property that makes §13.2's staging workable rather than merely defensible.

**Consequence for §12.2b's collision rules, re-checked rather than assumed.** Two cells are now
genuinely distinct scopes, so collisions that round 1 was resolving are **not collisions at all**. The
asymmetry table is unchanged in substance but its scope dimension is now "occurrence, else
coordinate, else whole-run": a repeated choice **within one scope** is still resolved best-rank-wins
with the drop residued, and a whole-run sheet behaves exactly as before, because it has no coordinate
and every row shares the empty scope.

**MEASURED, and the number moved as predicted.** P33 (per-cell long form): **15 rows → 90 rows, 75
`DROPPED_DUPLICATE_RANK` residue items → 0.** Seventy-five of five campers' answers were being
discarded. No other probe changed bucket, residue count or row count, and no probe reports a count
that disagrees with the rows it wrote.

**§12.4's traceability row and T279's `archive_when` are corrected, not quietly left.** The predicate
demanded "distinct **non-null** `occurrence_id`s", which implementation proved unachievable on this
path — the CLI passes no occurrences and no template exists at parse time (§13.2). The property that
actually matters, and is now true, is **one row per cell with its coordinate intact and no merge**;
`occurrence_id` may legitimately be NULL at import time. A predicate proven unachievable is reworded
on the record, never left standing as though it were still the target.
