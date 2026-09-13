---
title: T36-ingest-unlabeled-path-residuals
document_type: ticket
status: completed
created: 2026-08-03
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md]
archive_when: the three unlabeled-path residuals are closed - F1/F2/F3 all closed 2026-09-13
---

# T36 — Residual silent-omission / over-match vectors in the unlabeled ingest path

## CLOSED 2026-09-13 — all three, without waiting for a fifth camp

The ticket's posture was "harden before a 5th camp with these shapes", and the fix directions it
proposed all required a real file to calibrate against: distinguish a second activity from a
location by a page-level signal, distinguish a header from a body row by position. I asked the owner
for a fifth camp. **The owner reframed the problem instead, and the reframing dissolved the
blocker:**

> "if something says art on line 1 and art studio on line 2, chances are art studio is the place. if
> it is swim and swim return it isn't a place but a thing happening. so i'd rather us almost not
> infer but just flag that this isn't knowable from the way it is written"

That is the whole design. A CLASSIFIER needs examples of both classes to calibrate, which is why a
fifth camp seemed necessary. A FLAG does not — and where a decision genuinely is available, the
evidence is the DOCUMENT rather than the typography, which is what no amount of layout analysis
could have supplied.

**F2 — header mis-split. CLOSED, behaviour changed.** `TIME_HEADER_LABEL` matched by PREFIX, so any
first token merely beginning with a time word passed: `Period 2` (a period named in the body),
`Times Up` (an activity). Re-verified as still reproducing on 2026-09-13 before the fix. Now an
EXACT match against the label set, plus an optional trailing colon. The distinction is what the text
is DOING: a header labels the column, while "Period 2" names one particular period and is therefore
data. Measured against the corpus first — every time-labelled header in it is the single word
"Time" — so nothing real is refused. An existing test covering a `Time:` header caught the colon
omission in the first cut. `src/ingest/textGrid.f2.test.js`.

**F3 — banner over-strip. CLOSED, behaviour changed.** A one-word line repeated above each page
break was stripped. A camp name IS a banner; a centred "Dismissal" is content; typography cannot
tell them apart. The deciding evidence is now the document: a candidate that also appears as a whole
cell inside a real row is a thing the camp does, and is kept. Candidates are considered in order of
how often they repeat, and one the grid vouches for is SKIPPED rather than ending the search — or a
camp whose name repeats less often than a real event would keep its name as a phantom activity.
Separately, `parseTextGrid` now RETURNS the banner it removed; it had always computed it and thrown
it away, which is what made a removal invisible. `src/ingest/textGrid.f3.test.js`.

**F1 — location strip. CLOSED as a FLAG, deliberately not as a decision.** The reading is UNCHANGED:
a full-width row following another data row is still filed as the room printed under its activity,
so every current camp parses byte-identically. What is added is a report, because the one case it
gets wrong — a block stacking two activities with no blank line — files a real thing the camp does
as a place. `findAmbiguousLocations` flags a text filed as a location that the document ALSO
schedules as an activity cell somewhere else. "Art Studio" never appears as an activity; "Swim
Return" does. Silent on all three corpus samples, which is the test that matters: a flag that fires
on a camp importing correctly today would be noise. `src/ingest/textGrid.f1.test.js`.

All three reports surface in ImportScreen's existing "Not recognised" box, the transparency piece
the 2026-08-20 partial resolution shipped — no new chrome, and nothing blocks the import.

**Still true and still not built:** the lower-severity notes below (a 2+-token camp banner leaking as
phantom activities; welded narrow rooms) are unchanged, and remain candidates for T35's post-import
cleanup UX rather than the parser.

**Raised:** 2026-08-03, Red Hat review of the round-2 resilience fixes. **All three are proven
UNREACHABLE on the current four-camp corpus** (Camp A/B, Shemesh, campC-synthetic) — they are
follow-ups to harden before a fifth camp with these shapes, not shipping blockers. Round-2 closed the
round-1 findings; these are the narrower residuals left behind, and the code comments now say so
rather than claiming a general-case guarantee.

## F1 — the location strip drops a genuine second activity row (MEDIUM)

`closeBlock` (`src/ingest/textGrid.js`) drops any full-width value row that follows another data line
in the same blank-delimited block, on the assumption "second full-width row = the location under the
activity". True for every current period (one activity + one location per block). But a block that
stacks TWO activity rows with no blank line between — the shape Camp A uses for its nested swim
sub-schedule (Camp A is labelled, so spared) — would silently drop the second activity on a future
*unlabeled* camp, or on a PDF extraction that merges two periods by losing the blank line.
Proven: `Art / Room101 / Swim` in one block → `Swim` dropped.
Fix direction: distinguish a second activity from a location by a page-level signal (does the page
*consistently* carry one trailing data line per block?) rather than "any full-width trailing row is a
location". Do not pre-build until a real layout needs it.

## F2 — widened header match can mis-split a future labelled camp (MEDIUM)

`isHeaderLine` now accepts a first token matching `/^(time|times|period)\b/i` (FIX 2, so a "Times"/
"Period" time column routes labelled). A BODY row whose first cell begins with a time word — a period
literally named "Period 2", or an activity "Times Up" — would be misread as a header and start a
spurious page mid-body, corrupting the grid and possibly dropping the content above it.
Proven: `"Period 2  Art  Swim  Dance"` → `isHeaderLine === true`.
No such body line exists in Camp A/B/Shemesh. Fix direction: require the header match to also be
followed by a day-name-majority or a plausible column row, or anchor on position, so a lone body cell
cannot masquerade as a header.

## F3 — a centered single-token repeated event is still eaten as a banner (MEDIUM if reached)

`detectBanner` treats a single-token pre-title line that repeats on ≥ half the pages as a banner and
strips it. FIX 3 added the single-token guard to stop full-width fixed rows being eaten — but a
*one-word* fixed event printed centered above each page break (e.g. a centered "Dismissal") is a
single token and would still be stripped from every page.
Proven: three pages each ending with a centered `Dismissal` above the next title → `Dismissal`
silently removed.
Not reachable on Shemesh (its fixed events carry their own time labels, are full-width, and sit inside
the body, not above a title). Fix direction: only strip a banner candidate found in the pre-header gap
region, never a token that also appears inside a value row.

## Lower-severity, noted not ticketed separately
- A 2+-token camp banner (`Shemesh   Camp`, wide gaps) now leaks as phantom activities — recoverable
  over-inclusion, the ADR-safe direction, brittle to banner typesetting.
- Welded narrow rooms (`Group Time Social Hall`) — the accepted R3a over-inclusion; a clean concept can
  end up only in welded variants, so the director renames rather than unticks. Candidate to fold into
  [[T35]] (post-import cleanup UX) rather than the parser.

## Governance
Database/sync row. No schema change; parser methodology. An addendum to ADR 2026-08-01 §7 if/when any
is built, plus the mandatory integration coverage. Sequence after the current owner priorities.

## Partial resolution (2026-08-20) — residual-report shipped; parser residuals still deferred

The **residual-report UI** (the "what was dropped" transparency piece that T49 described and no code
implemented) is now SHIPPED: `workbookToPages` returns `.residual` for sheets with content but no
recognisable header; `extractEntities` returns `residual.cells` for cells that fail `isActivityLike`;
`ImportScreen` renders a non-blocking "Not recognised" box before commit. Code Reviewer merge-ready,
full gate green. Documented boundary: residual capture is WHOLE-CELL only — a dash-split cell that
yields at least one activity-like part does not flag its trailing fragment (usually an intentional
room/person annotation), by design, to avoid alarming the director.

**This ticket stays OPEN.** Its `archive_when` is the three PARSER over-match/silent-omission vectors
(F1 location-strip, F2 header mis-split, F3 banner over-strip in `textGrid.js`) — all still deferred,
proven unreachable on the 4-camp corpus (harden before a 5th). The residual-report does not close them.
