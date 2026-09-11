---
title: Critique Fix Queue — end-to-end walkthrough findings
document_type: spec
status: active
authority: subordinate-to-constitution
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md]
owner: Governor (session app-icon-audit-a9a598)
created: 2026-09-11
archive_when: T122–T139 are each shipped, declined, or promoted to their own ticket file
review_trigger: any item promoted to an ADR; any owner decision on the three deferred questions
---

# Critique fix queue

## Status, 2026-09-11

| Ticket | State | Note |
|---|---|---|
| T122 imported blocks sort by file position | **shipped** | camp-day rule; leading-zero exception removed after campB disproved it |
| T123 sidebar stale after a local write | **shipped** | new `localClient.onLocalWrite` channel |
| T124 Fixed/Recurring double-counted | **shipped** | AREA_TABLE entries may carry a `kind` |
| T125 colliding React keys | **shipped** | scope added to the fixed-event key |
| T126 no focus ring | **shipped** | one rule in index.css; both `outline:none` deleted |
| T128 forced re-login | **shipped** | bootstrap routes through the audited `login` |
| T132 change-overs imported as periods | **shipped** | threshold 10 min, set by the corpus not by taste |
| T133 activities filed as groups | **CLOSED, not a defect** | the source puts them in the group slot; see below |
| T134 fragments and column bleed | **shipped** | flagged, never dropped |
| T135 repeated anchor chips | **shipped** | display fix; the data was right |
| T136 reconciliation asks about the wrong things | **partly shipped** | suspects surface in the import preview; reconciliation itself untouched |
| T137 sweep harness crashed on .txt | **shipped** | and immediately caught a real bug in T122/T132 |
| T127 reconciliation's exits | **shipped** | one always-reachable primary; counts name their unit |
| Generated route opens to the schedule | **shipped** | owner directive; concerns row moved below the grid |
| T129 sidebar marks | open, **reframed** | make the marks self-evident; a legend is help, and help is out |
| T139 first-run continuity | open | background, wordmark, Seed double-title, placeholders |
| T131 group-list walls | open | activity rows print every group as raw text |
| T127 bulk actions | **shipped** | identical questions asked once; 240 buttons -> 32, 15.2 screens -> 2.1 |
| T130 row Delete shouting | **shipped** | quiet row action across 10 sites; Delete All stays loud |
| T131 import preview | **partly shipped** | commit button is sticky; the group-list walls remain |
| T138 file input | **shipped** | drop zone, stated formats, styled control |

**T133 is closed as not-a-defect, and two claims in this file were wrong.**
The three "misclassified groups" come from page titles the source itself shapes
as `<Tier> - <Group>`: `Maple 3- Cooking/ Baking/ Dance`. The parser handled
ambiguous input correctly, and a rotation cohort is a plausible group. Separately,
`"Digital Art/Coding/Coding"` was reported here as a parse artifact — it is not.
The doubled word is in the camp's own file.

A group-outlier rule WAS written for T134 and then deleted rather than shipped:
campA titles 30 of its 33 pages "<Bunk> Schedule" and the three exceptions are
the suspects, which is a real signal — but by the time groups reach the detector
the tier and trailing word are stripped, so it fired on a synthetic fixture and
on nothing in the corpus. It belongs at the page-title layer and wants its own
ticket.

**One new ticket found while fixing T132.** The four bare timestamps in campA
("11:10", "10:25", "12:30", "11:45") are not stray non-periods — the source wraps
period labels across two lines:

    9:50- Block
     10:25   1

so "9:50-10:25, Block 1" is read as two fragments and the real 9:50-10:25 period
survives ONLY as the orphan "10:25". Dropping bare timestamps would delete it.
That is a textGrid parsing fix, unstarted.

Derived from the 2026-09-11 fresh-eyes end-to-end run (first launch → create camp →
import `campA-bunk-schedules.txt`, 79KB of real messy camp grid → reconcile →
generate) and the Nielsen heuristic scores from the same run.

Design Health at time of audit: **25/40**. The three heuristics scoring 1–2 —
Flexibility & Efficiency (1), Help & Documentation (1), Visibility of System Status
(2), Recognition over Recall (2) — account for most of the queue below.

Two items are already root-caused to a line. The rest are symptom-level and want a
diagnosis step before an estimate.

---

## Tier 0 — The app states things that are untrue

These are not polish. In each case the interface asserts something false, which is
the fastest way to lose a director's trust. All four are bug-fix seams and want a
failing test first, per the standing rule.

### T122 — Imported time blocks sort by file position, not by time
**Severity: highest. The core artifact is unreadable.**
A generated day renders `9:15 → 10:30 → 11:10 → 11:50 → 3:15 → 12:30 → 1:50 →
1:05 → 2:30 → 1:10 → 11:45`. A camp director's day is not in time order.

Root cause, confirmed: `src/ingest/buildPlan.js:149` writes `sort_order: index` —
the row's position in the parsed file. The hand-edit path is already correct:
`src/screens/TimeBlocksScreen.jsx:46` writes
`sort_order: minutesFromMidnight(start)`. So blocks a director types sort by time
and blocks they import sort by file order.

Second half of the same bug: `parseTimeRange` (`buildPlan.js:116`) reads a bare
12-hour label, so `"3:15-3:40"` becomes `03:15` and would sort before 9:15 even
after the first fix. `src/ingest/parseGridSchedule.js:21` already notes machinery
for telling "an unambiguous time from a bare 12-hour guess" — reuse it, or infer
meridiem monotonically across a day's blocks.

Test first: a fixture whose rows are deliberately out of file order, asserting
render order is chronological.

### T123 — Sidebar counts never refresh after a local write
**Severity: high. The app looks broken at the exact moment it has just succeeded.**
Immediately after import, Roots says "Age Divisions 13 / Groups 33 / Activities 109"
while the sidebar six inches away says `! Age Divisions needed`, `! Groups needed`,
`! Activities needed`, and the attention panel says "Nothing needs you right now."
A page reload corrects all of it, which proves the data is right and the view is
stale.

Root cause, confirmed: `src/hooks/useSetupCounts.js:68-72` refreshes only on
`localClient.onOpApplied` — the SYNC channel, i.e. an op arriving from another
device. A local write on this device never fires it. `refreshCounts` is not
returned from the hook, so no screen can trigger it either. **Local writes have no
refresh path at all.**

Recommended fix: make the local write path emit the same applied signal rather than
returning `refreshCounts` and calling it from every mutation site. One seam fixes
every screen; the alternative spreads refresh bookkeeping across dozens of call
sites and will rot. Confidence: high.

### T124 — Fixed Events and Recurring Events report the same rows twice
Sidebar shows `Fixed Events 112` and `Recurring Events 112` — the same 112
`anchor_activities` rows counted once each. `AREA_TABLE` counts the table unfiltered
by `kind`, a limitation already noted in `navSections.js`. The two rows were
deliberately un-conflated as a product decision; the counts did not follow.

### T125 — Duplicate React keys in the schedule render
Console, on real imported data: `Encountered two children with the same key` for
`Instructional Swim 11:50-12:25 Monday,Tuesday,Wednesday,Thursday` and
`Recreational 11:10-11:45 Monday,…`. React's own warning says children may be
"duplicated and/or omitted" — on a schedule grid that is a correctness risk, not a
console-noise issue.

---

## Tier 1 — Accessibility floor

### T128 — Forced re-login immediately after creating the account
**Promoted from Tier 2 on review.** This was ranked too low the first time.

Bootstrap collects the director's name and PIN, creates the account, and then drops
them on a Sign in screen with an **empty Name field** — thirty seconds after they
typed it. The honest reading for a non-technical director is "it didn't save."

It sits at the highest-stakes moment in the product: the instant after committing to
it. It is also one of the smallest fixes in the queue. Sign them in directly, or at
minimum prefill the name.

### T126 — No visible focus indicator anywhere outside the schedule grid
`src/styles/shared.js` sets `outline: 'none'` on both `S.input` and `S.authField`,
and nothing replaces it. Verified live: a programmatically focused button is
pixel-identical to an unfocused one. The only focus styling in the app is scoped to
`scheduleGrid.css`.

One rule in `src/index.css` covers the whole app including inline-styled elements:

    :where(button, a, input, select, textarea, [tabindex]):focus-visible {
      outline: 2px solid var(--primary);
      outline-offset: 2px;
    }

Cheapest item in the queue by impact-per-line. Do it in the first batch.

---

## Tier 2 — The app blocks you (Flexibility & Efficiency = 1/4)

### T127 — Reconciliation is a 240-button wall with no bulk action
After importing one real file: 15 screens, **240 buttons** — 49× "Use this value" /
"Keep current", 25× "Create elective set" / "Not electives", 75× "Why?". No
select-all, no "accept all guesses", no domain filter.

Three separate defects inside one screen:
1. **No bulk resolution of any kind.**
2. **Inverted hierarchy.** The navy PRIMARY button ("Use this setup") stays disabled
   until all 79 items are resolved; the only achievable exit ("Apply confirmed
   changes and keep the rest for review") is the lower-contrast SECONDARY, itself
   disabled until one item is resolved. The reachable action must be the primary.
3. **The numbers disagree.** The tile says "1 Needs attention"; the primary button's
   tooltip says "Resolve the 79 items marked for your attention first."

**Correction to an earlier note in this file:** T95 and T96 do NOT overlap this.
T95 is a domain *filter* (a lens over the list); T96 is a field-level `was →
will-be` *diff view*. Neither addresses bulk resolution, the button hierarchy, or
the disagreeing counts. Both are LOW/LOW-MED and both say "revisit on evidence" —
this walkthrough is that evidence, and T95's stated reason for deferral ("no
evidence yet that a director needs multi-domain combination") is now weaker: with
79 items spread across domains, filtering is how a director would triage.

---

## Tier 3 — Legibility and scan (Recognition over Recall = 2/4)

### T129 — The sidebar's status vocabulary has no legend
`✓ / ! / ·` plus the words `needed / optional / attention`, plus a fourth
colour-only state (the warning-tinted dot for expected-but-empty) — and no key
anywhere in the UI. The expected-but-empty state violates `Sidebar.jsx`'s own
comment that colour is never the sole carrier. Give that state its own glyph, and
add a static one-line key in the existing sidebar footer type style. **Not a
banner.**

### T130 — Activities makes deletion the loudest thing on screen
109 rows, 12.5 screens, **57% of table cells are an em-dash**, and **109 red
`Delete` buttons** running down the page. On the screen where a director reviews
their program, the highest-contrast repeated element is Delete. Demote it to a
row-hover or row-menu action and collapse columns that are empty for every row.

### T131 — The import preview is 14 screens with a non-sticky commit
`main` scrolls 10,718px against a 768px viewport; the commit button is
`position: static` at the very bottom. The Activities section prints every
applicable group as raw text ("Groups: Mountain View, Lanterns, Wildcats, Falcons,
Dolphins, Compass, Tulip, …"), and every row reads an identical "1–3×/wk · Low".
Summary first, sticky commit, and say "all groups except X" when a rule is near
universal.

---

## Tier 4 — The ingest route (decomposed)

**This tier was one vague ticket in the first draft of this file. That was wrong.**
Re-running the extractor headlessly over the committed sample
(`docs/work/specs/samples/campA-bunk-schedules.txt`, 79KB of real camp grid)
produces **four distinct defect families with four different root causes**, plus a
broken harness. Counts below are measured, not estimated.

Reproduce: `extractEntities({ pages: parseTextGrid(text).pages })`.

### T132 — Time-block extraction admits things that are not periods
Produces **15 time blocks, of which 6 (40%) are not periods**:

- **Four bare timestamps with no range** — `"11:10"`, `"11:45"`, `"12:30"`, `"10:25"`.
  A time block with no end time is not a block.
- **Two five-minute change-over slivers** — `"1:05-1:10"`, `"11:45-11:50"`. These come
  from the source file's `"11:10-11:20 Change"` rows, which are transitions between
  periods, not schedulable periods.

Both are mechanically detectable: reject a block with no parsed end time, and treat a
sub-N-minute span as a change-over rather than a period (N is a product call; the
source file's own change-overs are 5 and 10 minutes).

Note this compounds T122 — a director looking at a scrambled day is also looking at a
day with four phantom periods in it.

### T133 — Activities are misclassified as groups
**3 of 33 groups (9%) are activities**: `"Cooking/ Baking/ Dance"`,
`"Digital Art/Coding/Coding"`, `"Lego/DIY/Mural"`.

`"Digital Art/Coding/Coding"` also has "Coding" twice — a separate splitting artifact
inside the same string, which suggests the slash-splitting and the group-detection
paths are both involved.

A group is a bunk of campers; an activity is a thing they do. A slash-joined list of
verbs is never a bunk name. This is the highest-confidence heuristic available in the
whole ingest route and it is not being applied.

### T134 — Activity names carry sentence fragments and column prefixes
**8 of 109 activities (7%)** are not activity names:

- **Sentence fragments** — `"and Mitzvah"`, `"and Mitzvah Project"`, `"A/C"`,
  `"A/C Preschool"`. A name beginning with a conjunction is a fragment of a longer
  cell that was split in the wrong place.
- **Column-prefix leakage** — `"Block 1 Sport Workshop"`, `"Block Playground"`,
  `"Block Sports"`, `"Block Teva"`. "Block" is the *period* column's word, bleeding
  into the activity name.

(`"Art"` also trips a short-name heuristic and is a false positive — it is a real
activity. Any rule here must be a flag for review, never a silent drop.)

### T135 — Anchors arrive with duplicate, undifferentiated names
The same file produces **112 anchors**, and Roots renders the first six as
`Indoor Elective, Indoor Elective, Indoor Elective, Instructional, Instructional,
Instructional`. Whatever distinguishes them is not in the name, so nothing in the UI
can tell them apart. This is also why reconciliation asks the *identical* "Create an
empty 'Indoor Elective' elective set?" question 25 times.

### T136 — Reconciliation asks about the wrong things
The surfacing ticket, and it depends on T132–T135 landing first.

With one real file, reconciliation spends **79 questions** on elective periods and
asks **zero** about `"and Mitzvah"` or the four phantom time blocks. The parser will
never be perfect on input this messy and that is fine — but the screen that exists to
catch its mistakes is currently looking in the wrong direction.

Flag the records T132–T134 identify, and stop asking 25 identical questions.

### T137 — The ingestion sweep harness crashes on the repo's own samples
`npm run ingest:sweep -- --dir docs/work/specs/samples --file campA-bunk-schedules.txt`
dies with `TypeError: Cannot read properties of null (reading 'entities')` at
`scripts/ingest-sweep.mjs:142`. The harness handles workbooks but not the `.txt`
grids committed alongside it, and does not guard the null.

Low severity, but it is the tool that would have caught T132–T135, and it cannot run
on the fixtures the repo ships.

## Tier 5 — Polish

### T138 — The primary onboarding control is an unstyled native file input
"Import last year" is the primary button on `SeedScreen`, and it leads to a raw
`<input type=file>` with default browser chrome ("Choose Files / No file chosen") in
an app where every other control is deliberately styled. There is **no drag-and-drop
handler** (confirmed: no `onDrop`/`onDragOver` in `ImportScreen.jsx`), and the
accepted formats (`.xlsx,.xlsm,.xls,.txt,.csv,.tsv`) are never shown. The filename
is then printed twice.

### T139 — First-run visual continuity
Small, same area, worth one pass: the root-pattern background appears on
ModeSelect and vanishes on Bootstrap; the "Shoresh" wordmark is a display serif on
Login and a sans everywhere else; SeedScreen prints its title twice (TopBar +
heading); placeholder convention is inconsistent ("Camp Willowbrook" vs "e.g. Sarah
Cohen").

---

## Owner decisions, 2026-09-11 (resolved)

**1. The app does not offer help, and that is permanent.** Asked whether Help &
Documentation scoring 1/4 should be fixed, the owner's answer was: *"the app does
not help at all. if it needs help, then we have UI wrong."*

This is a standing constraint, not a ticket closure. Help is not a feature this
product will grow; a screen that needs explaining is a screen to redesign. Two
consequences:

- Heuristic 10 is permanently **n/a** for this app. Do not re-raise it.
- **T129 is reframed, not cancelled.** The sidebar's `✓`/`!`/`·` needing a legend
  is evidence that the MARKS are wrong, so the fix is to make them read without
  a key — not to add one. A legend would be help, and help is the thing we do
  not do. Tooltips on disabled controls fall under the same rule, which is why
  T127's exit carries its state in the label rather than a `title`.

**2. Navigation is changing soon.** Germination / Sprouts / Plants stays untouched
until that lands. No work against the current labels.

**3. The generated route opens to the schedule.** *"it should open to the
schedule."* Shipped — the concerns row moved below the grid. The engine has just
done twenty minutes of the director's work; leading with a row of counts of what
is still wrong reads as an audit of the result rather than the result.

## Deliberately NOT queued — these are owner decisions, not defects

1. **Help & Documentation scores 1/4** because there is no help affordance anywhere
   in `src/`. That is a product decision about whether this app has help at all, not
   a bug to fix. Raise it; do not let an engineer settle it.
2. **Germination / Sprouts / Plants** as the only navigation headings. The comments
   in `navSections.js` describe each section in plainer camp language than the label
   above it. Changing them is a brand decision.
3. **The route chooser before the payoff.** The generated schedule opens with a row
   of concern counts and the reassurance ("Nothing here is a mistake. It's what's
   left to place") is hidden inside a rail the director must open first.

## Recommended sequence

**Batch 1 — trust.** T122, T123, T126, T128. The two lies, the one-line a11y fix, and
the re-login. Between them they remove every moment in the walkthrough where the app
looked broken or unsaved. All four are small and all four are testable.

**Batch 2 — the ingest route.** T132, T133, T134, T135, then T136 once those land,
with T137 first if the harness is wanted as the regression net. This is the largest
block of real work in the queue and the one with the most product value: it is the
difference between "it read my spreadsheet" and "it read my spreadsheet correctly."

**Batch 3 — correctness tail.** T124, T125.

**Batch 4 — the wall.** T127.

**Batch 5 — scan and polish.** T129, T130, T131, T138, T139.

Batch 1 is worth doing regardless of what happens to the rest. Batch 2 is what
decides whether the product's central claim holds up on a real file.
