---
title: "The schedule-shape import gate moves from whole-file to per-page granularity"
document_type: adr
status: accepted
authority: normative
implementation_state: implemented
date: 2026-09-18
decided: 2026-09-18
deciders: [product-owner]
governing_docs: [docs/governance/standards/ARCHITECTURE_STANDARD.md]
supersedes: []
related_adrs:
  - docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md
related_tickets:
  - docs/work/tickets/T223-shape-gate-page-granularity.md
---

# The schedule-shape import gate moves from whole-file to per-page granularity

## Context

T146 added `isScheduleShaped` (`src/ingest/scheduleShape.js`) to refuse a workbook that is not a
schedule (a campus-map template, a legend sheet) before `extractEntities` could mint its grid
coordinates or legend keys as camp entities. T224 wired the same gate into the CLI/MCP ingest path,
after a camper elective-selection workbook committed its own column headers (`#1`, `#2`, `Division`)
as 33 groups and 33 tiers through that path.

Both fixes shared one blind spot: `isScheduleShaped` is a **whole-file** predicate
(`pages.some(...)`) — true if *any* page in the file looks like a schedule. `extractEntities` is
**per-page** — it extracts from every page it is handed, not just the one that passed the gate. So a
workbook with one schedule-shaped page (a day × period elective menu) and one non-schedule sibling
page (a camper-selection sheet) passed the gate whole, and the selection sheet's headers were still
extracted. T146/T224's fix narrowed the campus-map case; it did not close this one — see T223.

## Options considered

1. **Per-page gate, with an inherit-from-previous-page rule** for continuation pages that carry
   neither axis (a real multi-page schedule where the day header only appears once, on the first
   page). Rejected: the inheritance rule is itself a judgment call with its own failure modes (which
   page is "the same schedule" as the one before it? across a sheet boundary? across a file
   boundary in a multi-file import?), and gets no evidence from the corpus to calibrate it against
   — see the corpus check below, which found no continuation pages in this shape today.
2. **Per-page gate that declines individual pages but surfaces the declined list to the director/CLI
   operator**, rather than silently dropping it. Chosen — see below.
3. **Leave the whole-file gate as-is and rely on the post-import summary** to make a laundered `#1`
   or `Division` group obvious enough to catch on review. Rejected: this is exactly the failure T146
   and T224 already treat as unacceptable — a polluted camp reachable by walking through a normal
   import, with the safety net being "the director notices," not a refusal.

## Decision

`isSchedulePage(page)` is the same per-page test the old whole-file predicate applied to every page
in its `.some(...)` — `hasDayColumns(page.columns) || titleNamesADay(page.title) ||
hasTimeRowLabels(page.rows)` — now extracted and exported directly. `partitionSchedulePages(pages)`
runs it over every page and returns `{ shaped, declined }`.

Both schedule-path entry points (`src/screens/ImportScreen.jsx`, `scripts/ingestCli.js`) now:
- Refuse the whole file, with the existing refusal message unchanged, only when **no** page
  qualifies (`shaped.length === 0`) — the file-level bias toward acceptance from T146 is preserved.
- Extract only from `shaped` pages (`extractEntities`, `inferFixedEvents`, and on the UI path also
  `proposeSpecialDay` and `capturePlacements`) — closing the laundering.
- Surface `declined` page titles rather than dropping them: the CLI/MCP result gains a
  `declinedPages` field (printed by `scripts/ingest.js`, passed through untouched by
  `scripts/mcp/tools.js`); the UI's existing "Not recognised" box (already listing residual sheets,
  ambiguous locations, stripped banners) gains a bullet list for declined tabs.

`isScheduleShaped(pages)` keeps its original whole-file contract — it is now defined as
`partitionSchedulePages(pages).shaped.length > 0` — so every existing caller and test of it is
unaffected; nothing needed to migrate off it, since neither the ticket nor a graphify blast-radius
check (`graphify affected "isScheduleShaped"`) found a caller that needed anything else. It remains
in place mainly to document that the file-level bias toward acceptance is unchanged: a file is still
admitted if even one page qualifies, exactly as before.

## Why this doesn't reopen T146's bias at the file level

T146's stated bias was to accept a file so long as it has genuine positive evidence anywhere in it,
because a false reject blocks a real camp's real file — worse than a false accept, which this module
exists to catch downstream instead. That bias is preserved unchanged: `isScheduleShaped` still
returns true under exactly the same condition as before (at least one page qualifies), so a file is
never refused today that would have been accepted before this change.

What changes is **where extraction reads from within an accepted file** — page by page, matching
`extractEntities`'s own granularity, rather than admitting the whole file once any page clears the
bar. A page's exclusion is not silent: it is reported, so a genuine continuation page that this
predicate cannot currently recognize (option 1) would show up as a declined tab the director or
operator can act on, rather than either being extracted wrongly or dropped with no signal at all.

## Corpus evidence

Every page of every real sample in the corpus (`docs/work/specs/samples/*.txt` — campA: 33 pages,
campB: 5, campC: 3) individually passes `isSchedulePage` — verified while designing this fix and
pinned as a regression test (`src/ingest/scheduleShape.test.js`, "every page individually passes
isSchedulePage"). Filtering to `partitionSchedulePages(pages).shaped` is therefore a no-op against
every real corpus sample on file; it only ever excludes a page that would never have passed the gate
on its own, i.e. exactly the class of page (a selection form, a legend sheet) T146/T224 already
intend to refuse.

## Consequences

- A mixed workbook (a real schedule tab plus a non-schedule sibling tab) now commits the schedule and
  reports the sibling as declined, instead of either refusing the whole file or extracting the
  sibling's headers as entities.
- If a real camp's export turns out to have a genuine continuation page with neither axis, this
  design surfaces it as a declined tab rather than silently dropping or wrongly extracting it — which
  is diagnosable and fixable without another laundering incident, but it is still a page dropped from
  extraction until (if ever) option 1's inheritance rule is designed with evidence behind it.
