---
title: "Anchor scope is read from raw columns in several places; route every consumer through one shared resolver"
document_type: ticket
status: completed
created: 2026-09-16
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/governance/standards/TESTING_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_tickets:
  - docs/work/tickets/T62-engine-schedules-anchor-activities-as-regular-slots.md
  - docs/work/tickets/T180-recurring-event-division-scope-is-snapshotted.md
  - docs/work/tickets/T182-stale-anchor-duplicate-finding.md
related_adrs:
  - docs/adr/2026-08-28-fixed-vs-recurring-events.md
  - docs/adr/2026-09-16-anchor-scope-single-resolver.md
prior_dependencies: "T180 (src/engine/anchorScope.js / resolveAnchorGroupIds) and T182 (buildSchedule's group-resolution seam) — both landed on main 2026-09-16; PR-1 (read side) builds on them."
archive_when: (READ) every runtime consumer of anchor scope resolves it through the shared resolver(s) in src/engine/anchorScope.js — no consumer reads is_all_groups / group_ids / unit_id(s) directly to decide coverage — and a re-import of an unchanged division-scoped Recurring Event produces no spurious fixedScopeChanged drift; AND (WRITE) a Replace re-import of an unchanged division-scoped Recurring Event leaves its director-set unit_ids INTACT (preservation, not merely a warning), and any case that genuinely cannot be preserved is surfaced on the reconciliation report rather than lost silently — each pinned by a test
---

# T183 — Consolidate how anchor scope is read across the codebase

**Risk:** Medium — user-visible scheduling correctness (already produced three
proven bugs today) plus a false-positive on the reconciliation surface. No
stored-data-shape change; this is a read-path consolidation.
**Task class:** engine / ingest / setup UI refactor at a correctness seam.

## Problem — the defect class

An anchor (`anchor_activities`) row carries several scope columns. Consumers
read them *directly* and trust that the column name means what it implies. Over
2026-09-16 the same mechanism surfaced as three separate proven bugs and one
false warning, each in a different disguise:

1. **buildSchedule.js** (T62 / #443) — anchor→activity was read via a
   nonexistent `activity_id` column, so the engine's exclusion Set was empty in
   production for a month while a hand-built test fixture kept it green. Fixed:
   anchors resolve to activities BY NAME via
   `src/engine/anchorActivityLink.js` (`resolveAnchorActivityIds`).
2. **weekCatalog.js** (#443, deepened by T180) — the same broken read meant week
   activity/location exclusions never suppressed an anchor; and a division-scoped
   event carries `group_ids: '[]'` by design, so a week exclusion could never
   suppress it. Two real bugs, one column read.
3. **electron/ops/ingest.js `liveAnchorScope`** (~line 1631) — builds its drift
   map from `is_all_groups` / `group_ids` only. Post-T180 a division-scoped
   event has empty `group_ids` + populated `unit_ids`, so re-importing an
   unchanged row produces a spurious *"scope changed from (nothing) to Aleph,
   Bet, Gimel"* on the reconciliation surface. Report-only (ADR §4 read-only,
   pushes to `fixedScopeChanged`, never writes) — a false warning, not
   corruption, but noise on a surface whose whole job is to be trustworthy.
4. **src/screens/AnchorsScreen.jsx `anchorTierLabel`** — the coverage display
   read scope the same way (`group_ids` → tiers). T180 patches it inline to
   read `unit_ids` first with a group_ids fallback.

The unifying fault: the **scope-precedence rule**
(`unit_ids > unit_id > is_all_groups > group_ids`) is re-encoded at each read
site, so any two can drift — and did.

## What T180 already fixes (do not redo)

T180 introduces `src/engine/anchorScope.js` → `resolveAnchorGroupIds(anchor, groups)`
(pure, returns group ids, resolution order above) and routes through it:

- `buildSchedule.js` Pass-1 placement loop → resolver.
- `weekCatalog.js` suppression path → resolver.
- `AnchorsScreen.jsx` editor pre-tick, import write, and `anchorTierLabel`
  (inline `unit_ids > group_ids`, projected to division **labels** not ids).

T182 (eager-cray) then extracts buildSchedule's group-resolution into a shared
`anchoredActivityIdsByGroup` helper reused by Pass-1 and `computeFindings`; its
one resolution block routes through `resolveAnchorGroupIds`.

So three of the "five consumers" are handled upstream before this ticket lands.

## Net-new scope of T183

1. **electron/ops/ingest.js `liveAnchorScope`** — route through
   `resolveAnchorGroupIds`, eliminating the spurious drift. Two traps
   (confirmed with gracious-thompson):
   - **Parse before calling.** Rows read straight from SQLite carry JSON
     *strings*; the resolver does NOT deserialize. `unit_ids`/`group_ids` must
     be real arrays or `Array.isArray` is false and the resolver silently falls
     through to the legacy branch. Parse with the same defensive posture as the
     existing `group_ids` try/catch (null sentinel → skip drift check).
   - **`groups` needs `tier_id`.** The live group selects at ingest.js:518/909
     are `SELECT id, name` — no `tier_id`, so division scope cannot resolve.
     Add a `SELECT id, tier_id FROM groups WHERE camp_id = ?` read alongside the
     `liveAnchorScope` scan (do NOT disturb 518/909), add `unit_ids` to the
     `SELECT ... FROM anchor_activities` in the scan, and pass the live group
     list at evaluation time.
   - Keep it strictly report-only per ADR §4.
   - **Ownership: confirmed T183's** (leaving T180 as-approved is the default;
     folding in would need fresh owner approval). Blocked only by the same
     T180+T182 hold as the rest of this ticket.
2. **AnchorsScreen division-label resolution** — factor the shared precedence
   so the label projection and the group-id projection cannot drift (ADR item
   2/3, option C, with gracious-thompson's agreement to supersede the inline
   `anchorTierLabel` fix). Add `resolveAnchorUnitIds(anchor, groups) →
   { unitIds, inferred }` to anchorScope.js. **Caveat:** deriving divisions
   backward from a legacy `group_ids`-only row is lossy — it cannot tell "whole
   division" from "one bunk" (both → `['t1']`). The atom flags that answer
   `inferred: true` and the label must not render it as stored division scope.
   This item is mine regardless of the ingest ownership ruling.

3. **Importer WRITE path preserves division scope** (the write half; see
   "Write-side gap" above). Two seams:
   - **Create path** (`plan.fixedEvents` loop, ~ingest.js:2073): carry the
     source's division scope through to a written `unit_ids`, instead of only
     `is_all_groups`/`group_ids`. Requires deciding how a division is expressed
     in the import source (the Excel grid is bunk/group-oriented and has no
     division column today; anchors are not in the export). This is a genuine
     design question — resolve it in the ADR before coding, and it may require a
     representation for division scope in the import model, not just a new
     write field.
   - **`replaceScope`** (ingest.js:125-129): a Replace re-import must not
     silently destroy division scope that only lives in the DB (created in-app,
     never in any file). Options to weigh in the ADR: preserve app-authored
     `unit_ids` across a replace, or at minimum surface the flattening on the
     reconciliation report rather than losing it silently (contrast with the
     current read-only drift path).
   - Pin with a test: create a division-scoped anchor, run a Replace re-import,
     assert `unit_ids` survives (or that the loss is reported, per the ADR
     decision).

## PR-1 review outcome (code-reviewer + red-hat, 2026-09-16)

Both reviewers independently found ONE MEDIUM: the ingest.js liveAnchorScope
branch checked `is_all_groups` before division scope, inverting the resolver's
precedence — a `kind='recurring'` row transiently carrying `is_all_groups=1`
with stale `unit_ids` (op-replay window) would resolve as all-groups here but as
the division in the engine/label, reintroducing the drift class for that row.
FIXED: division scope is now checked first and stored with `is_all_groups=0`
(pinned by the "red-hat" transient-state test). Note: the reviewers' suggested
"just always delegate to resolveAnchorGroupIds" would have broken the all→all
case (resolved all-ids vs incoming []), so the fix honors precedence while
keeping the all-groups flag representation the compare needs — verified against
all 14 scope-drift cases.

Two LOW items, neither blocking PR-1:
- The all-groups branch compares against the stored `group_ids` column, not the
  live full group list. Pre-existing behavior (predates T183), not a regression;
  left as-is, noted as a possible follow-up.
- The `inferred` affordance is a tooltip only, invisible on a touch/no-hover
  review pass. Matches the ADR's "exact rendering is a Designer call" carve-out;
  flagged to the owner/Designer as a follow-up. Visible text still names the
  division it covers, so nothing reads as broken.

## Delivery: two PRs

- **PR-1 — read side (DONE, committed).** resolveAnchorUnitIds atom + AnchorsScreen
  label supersession + ingest.js liveAnchorScope division resolution. Closes the
  spurious re-import drift and the label drift. Tested: anchorScope (8),
  AnchorsScreen (+2), ingest.scope-drift (+1), 253 sibling engine/ingest tests
  green. Owner-approved design.
- **PR-2 — write-side preserve (DONE).** Owner chose "Preserve + report", implemented in `electron/ops/ingest.js`:
  - Before `replaceScope`'s teardown, snapshot each division-scoped anchor's `unit_ids` as division NAMES, keyed by a label/name **`divisionPreserveKey`** (NOT `anchorSlotKey` — days/time_blocks are also recreated with new ids, so an id-based key can't survive the teardown; the director-visible day label + block name + event name + cohort do).
  - On recreate, re-resolve those names to the NEW tier ids via the importer's existing `tierIdByName` map (same trimmed-key lookup as the group→unit link). Fully resolved → restore `unit_ids`, `is_all_groups=0`, empty `group_ids` (the AnchorsScreen shape; two scope columns never disagree). kind written first so the v65 CHECK's recurring branch holds.
  - Any preserved division NOT restored (renamed/removed in the new file, or the event moved off its slot) → reported on `outcome.fixedEvents.scopeFlattened`, never silently lost. Restored ones → `scopePreserved`.
  - Tests: `electron/ops/ingest.scope-preserve.test.js` (preserve across teardown with tier-id remap; residue reported when the division is gone; and the whitespace-division trim-keying edge — preserved-or-reported, never silent). 194 sibling ingest tests green.

  **PR-2 review hardening (code-reviewer + red-hat):**
  - **HIGH (fixed):** a multi-day fan-out event whose days had a MIXED outcome
    (one day's label drifted so it flattened while siblings preserved) was
    reported as fully `scopePreserved`, hiding the reverted days. Now a name is
    `scopePreserved` only if EVERY snapshot slot restored; any unrestored slot →
    `scopeFlattened` with an "N of M day(s)" reason. Pinned by the multi-day
    mixed test.
  - **MEDIUM (fixed at root):** `tierIdByName` was written UNTRIMMED
    (commitCreate) but read TRIMMED (seedNameMaps + the group→unit link + this
    restore), so a whitespace-padded division name false-flattened. Trimmed the
    write site to match all readers — one normalization across all three sites;
    also fixes a pre-existing latent group-link miss for freshly-created
    whitespace tiers. Pinned by the whitespace-preserve test; divisionEvidence
    suite green.
  - **LOW (fixed):** snapshot now scoped to the import's `cohort_id`, so a
    cohort-scoped Replace no longer mislabels other cohorts' torn-down anchors
    as flattened.
  - **Known limitation (accepted):** the survivor key is label-based, so if the
    new file spells a day differently year-over-year the slot false-flattens
    (reported, never silent). Inherent to label-keying — day/time_block ids are
    recreated, so no stable id key exists. See ADR.

  **Prior — PR-2 was NEXT (superseded above).** Owner chose "Preserve + report."

  **Finding that resizes PR-2 (verified 2026-09-16):** `replaceScope` deletes
  `REPLACEABLE_ENTITIES = [activities, groups, time_blocks, days_of_operation,
  tiers]`. So a Replace re-import deletes the DIVISIONS (tiers) too and recreates
  them by name with NEW ids. Preserving an anchor's `unit_ids` is therefore not a
  field-add: the pre-teardown snapshot must capture division **names** (resolve
  old unit_ids → tier names against the pre-teardown tiers), and the create path
  must translate those names → the NEW tier ids (a tier name→id map the anchor
  create path does not build today). Failure modes to design against with
  Red Hat: a division renamed/removed in the new file (name no longer resolves →
  residue → report), name collisions, partial tier recreation. This is why the
  write-side is a separate, independently reviewed PR, not a fast follow.

## Sequencing (hard)

- **Blocked on T180 + T182 landing on main.** The resolver is the single source
  of truth this builds on; T182 owns buildSchedule's seam. Land LAST, rebase
  onto both. Read-only analysis + this ticket + the ADR are done now; no
  implementation, no `npm run verify`, until both are on main and the gate
  token is handed over.

## Write-side gap — IN SCOPE (item 3 below)

T183 ownership is resolved (uncontested, mine; cranky stood down and the
coordinator concurs), and this write-side gap is folded into T183 at the
coordinator's request. Raised by cranky-sammet and **independently verified**
2026-09-16 against the main-based worktree:

- `grep -c unit_ids electron/ops/ingest.js` → **0**. The importer has no concept
  of division scope, and T180 does not touch ingest.js.
- The anchor create path (the `plan.fixedEvents` loop, ~ingest.js:2073) writes
  only `is_all_groups` + `group_ids` (JSON string). It structurally cannot
  represent `unit_ids`.
- `replaceScope` (ingest.js:125-129) **deletes every anchor in the camp**, then
  recreates from the file.
- Anchors are absent from `src/utils/exportWorkbook.js` (0 hits) — no
  export→import round-trip carries `unit_ids` even in principle.
- "Re-import last year" (Replace mode) is a real first-class workflow
  (`navSections.js:143`).

**Consequence:** a director creates a division-scoped Recurring Event (stored as
`unit_ids`, resolved live — T180's whole point), later runs a Replace re-import.
Every anchor is deleted and recreated with a `group_ids` snapshot of whatever
bunks were in the grid — **silently converting live division scope back into the
exact snapshot bug T180 was written to fix**, with nothing in the reconciliation
report saying it happened. Add-mode is safe (no delete; the drift path only
reports); the corruption is Replace-specific.

**Why this belongs near T183:** this ticket's `archive_when` is a *read-side*
predicate ("no consumer reads the columns to decide coverage"). It can be fully
green while the *write* side still flattens division scope on every
replace-import. The resolver is only half a fix if the importer can destroy what
it resolves.

Already handled and not part of this gap: `undoReferences.js` `unit_ids → tiers`
registration, done by gracious in 03305ea.

## Success predicate (observable)

- Re-importing an unchanged division-scoped Recurring Event produces **no**
  `fixedScopeChanged` entry (pinned by an ingest test).
- No runtime consumer of anchor scope reads `is_all_groups`/`group_ids`/
  `unit_id(s)` directly to decide coverage; each resolves through
  `src/engine/anchorScope.js` (pinned by test / grep-guard).
- Engine purity intact: `src/engine/*` imports nothing from `src/ingest` or
  `electron/`; consumers import the resolver, never the reverse.

## Non-goals

- No change to the stored scope columns or their write path (T180 owns writes).
- Not re-opening T180's inline AnchorsScreen editor/import logic beyond the
  label-precedence question.
- Not touching T182's finding logic, route scoping, or `findingReason` copy.
