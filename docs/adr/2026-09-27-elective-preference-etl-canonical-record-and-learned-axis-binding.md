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

**Per my brief the corpus is designed, not built, this round.**

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

## 9. Open questions for the owner

1. **Can we get one real Camp InTouch export from your camp?** *(Top question — the cheapest single
   thing that would de-risk this whole design.)* Everything in §1 is a blank planning form. The file
   that actually carries campers' answers comes out of the Camp InTouch portal, and nobody on this
   project has ever seen one. No published spec exists for any camp platform's elective export. One
   real export — even with the names removed — would turn shape class H from a guess into a fact, and
   would tell us immediately whether it carries a stable camper id (§4.4) or forces name matching.
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
