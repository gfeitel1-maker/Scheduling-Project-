---
title: Critique Fix Queue — end-to-end walkthrough findings
document_type: spec
status: active
authority: subordinate-to-constitution
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md]
owner: Governor (session app-icon-audit-a9a598)
created: 2026-09-11
archive_when: T122–T134 are each shipped, declined, or promoted to their own ticket file
review_trigger: any item promoted to an ADR; any owner decision on the three deferred questions
---

# Critique fix queue

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

Note T95 (reconciliation multi-select domain filter) and T96 already exist and
overlap; check them before opening new work.

### T128 — Forced re-login immediately after creating the account
Bootstrap collects name + PIN, creates the director, and then drops the user on Sign
in with an empty Name field. They just said who they are. Sign them in, or at least
prefill the name they typed 30 seconds ago.

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

## Tier 4 — Surface the data quality the parser cannot fix

### T132 — Obvious parse fragments ship as first-class records, unflagged
The real-file import produced 109 activities including **"and Mitzvah"**, **"and
Mitzvah Project"**, **"A/C"**, **"Block Sports"**, **"Block Teva"** — fragments,
with "Block" leaking in from the time-block column. They arrive with colour dots and
weekly targets, indistinguishable from "Swim".

The parser will never be perfect on input this messy, and that is fine — but the
reconciliation screen currently spends 79 questions on elective periods and asks
zero about "and Mitzvah". Flagging a suspect record is cheaper and more honest than
parsing harder.

---

## Tier 5 — Polish

### T133 — The primary onboarding control is an unstyled native file input
"Import last year" is the primary button on `SeedScreen`, and it leads to a raw
`<input type=file>` with default browser chrome ("Choose Files / No file chosen") in
an app where every other control is deliberately styled. There is **no drag-and-drop
handler** (confirmed: no `onDrop`/`onDragOver` in `ImportScreen.jsx`), and the
accepted formats (`.xlsx,.xlsm,.xls,.txt,.csv,.tsv`) are never shown. The filename
is then printed twice.

### T134 — First-run visual continuity
Small, same area, worth one pass: the root-pattern background appears on
ModeSelect and vanishes on Bootstrap; the "Shoresh" wordmark is a display serif on
Login and a sans everywhere else; SeedScreen prints its title twice (TopBar +
heading); placeholder convention is inconsistent ("Camp Willowbrook" vs "e.g. Sarah
Cohen").

---

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

**Batch 1 — trust.** T122, T123, T126. The two lies plus the one-line a11y fix.
Small, test-first, and between them they remove the two moments where the app most
looks broken.

**Batch 2 — correctness tail.** T124, T125.

**Batch 3 — the wall.** T127 (check T95/T96 first), T128.

**Batch 4 — scan.** T129, T130, T131, T132.

**Batch 5 — polish.** T133, T134.

Batch 1 is the one worth doing regardless of what happens to the rest.
