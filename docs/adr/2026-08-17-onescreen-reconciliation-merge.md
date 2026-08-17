---
title: "ADR: One-Screen Reconciliation — Merging the Upstream Ticking Step (Option A)"
document_type: adr
status: accepted
authority: normative
implementation_state: in_progress
date: 2026-08-17
decided: 2026-08-17
deciders: [product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
supersedes: []
extends: [docs/adr/2026-08-17-onescreen-reconciliation-projection.md, docs/adr/2026-08-10-ingestion-phaseC-compression-layer.md]
depends_on_external: []
related_discovery:
  - docs/work/runs/2026-08-17-reconciliation-acceptance-test.md
  - docs/work/specs/2026-08-17-reconciliation-r8-honesty-compression-design.md
program: ingestion-reconciliation-one-screen
---

# ADR: One-Screen Reconciliation — Merging the Upstream Ticking Step (Option A)

## Context

The acceptance-test run against a real 14-sheet prior-year workbook
(`docs/work/runs/2026-08-17-reconciliation-acceptance-test.md`, F1) found that the shipped
one-screen surface (the projection ADR this document extends) is a *receipt*, not a
*workspace*, for a clean import: the director's one real judgment — "is this seen-once
activity actually real, or a parse artifact?" — is made **upstream**, in `ImportScreen.jsx`'s
`buildPreview()`/ticking step, before `ReconciliationScreen` or `buildReconciliationReport`
ever run. A low-confidence create candidate that starts unticked simply never enters
`approved`, never reaches `buildPlan`, and leaves **no trace** anywhere the report can see. The
Designer's R8′ spec (`docs/work/specs/2026-08-17-reconciliation-r8-honesty-compression-design.md`)
recommended a lighter fix (Option B — surface the set-aside items as a read-only disclosure
row) but explicitly flagged Option A — folding the ticking judgment into the reconciliation
workspace itself, so there is genuinely one stage, not two — as the fuller direction. The owner
chose **Option A**, 2026-08-17, under the standing pre-production bias-bold posture (no live
camp data yet; correctness discipline still holds, but a larger structural cutover is
acceptable now in a way it would not be later).

This ADR specifies the seam. It reads `buildPlan.js`, `reconciliationReport.js`,
`reportToLanes.js`, `reconciliationResolutions.js`/`reconciliationTriage.js`, and
`ImportScreen.jsx` directly (not just the ADR/spec chain) because the actual finding changes
the shape of the fix: **the include/exclude mechanism this design needs already exists and
already works** — it is defeated by two specific, small, unrelated facts elsewhere in the
pipeline, not by a missing decision-kind.

### The load-bearing discovery

1. `buildPlan.js:329` hardcodes every `create` op's evidence as `{ tier: 'new' }`, unconditionally.
   `reconciliationReport.js`'s `HIGH_IDENTITY_TIERS` (line 25) always maps `'new'` to `CONFIDENCE.HIGH`,
   which `classifyItem`'s `create` branch (line 107-126) auto-collapses to `outcome: 'understood',
   decision: null` — **zero decision, regardless of how confident the candidate actually is.**
   `buildPlan` has no independent confidence computation for creates at all.
2. `preview.js`'s `lowConfidence` classification (`looksLikeAMerge` + `seenCounts`/`shareOf`,
   lines 26-41 and 107-126) is a real, working frequency-based judgment — but it is consumed
   **only** by `ImportScreen.jsx`'s initial-tick-state computation (lines 283-295), never passed
   to `buildPlan` or the report. It decides what gets excluded from `approved` before submission;
   it does not inform any decision the report can render.
3. Consequently a low-confidence create is invisible twice over: once because it's dropped from
   `approved` before `buildPlan` runs, and — separately, and this matters for the fix — even if it
   *were* included in `approved`, `buildPlan` would still stamp it `tier: 'new'`/HIGH and it would
   still auto-collapse to `understood`. Fixing only the first (removing the pre-filter) without the
   second would make every low-confidence candidate get silently created outright — the opposite
   failure mode, and the one the Designer spec's F1 analysis was implicitly worried about when it
   called folding ticking into the workspace "a real Architect-scoped change."
4. `reconciliationTriage.js`'s `applyResolutions` (called via `foldTriageInputs`, the function that
   turns triage answers into the final `commitIngest` payload) **already implements the exact
   hold-back semantics this design needs**, generically, for any `confirm_value` decision
   (`reconciliationResolutions.js:83-98`): an unresolved `confirm_value` decision has its
   `entityName` **removed from `approved[entity]`** before the real commit — the row is held back,
   not written, until the director explicitly resolves it (`action: 'looks_right'` or `'edited'`).
   This is not new; it is the mechanism that already protects a low/medium-confidence *field
   update* from writing unreviewed. It generalizes to a low-confidence *create* with zero changes,
   because `buildPlan.js:165` reads `approved[entity]` as the single list of names to consider for
   **both** match/update and create — a name absent from it is never processed at all, in either
   direction.
5. `buildPlan`'s fixed-event path has **no equivalent hold-back**.
   `commitIngest`'s `fixedEvents` array is not gated by `approved` at all —
   `reconciliationResolutions.js:89-94`'s own comment says so explicitly ("`approved` never gates
   the `anchor_activities` entity... a fixed-event confirm_value held back here writes a key
   nothing downstream ever reads. Harmless... left as-is."). Today this is harmless only because
   `ImportScreen.jsx:484` pre-filters `fixedEvents` by `chosenFixedEvents` before it ever reaches
   `commitIngest` — the same upstream-ticking pattern as creates, just for a different array. If
   Option A removes that pre-filter (which it must, to make fixed-event ticking part of the
   workspace too), this gap becomes live: an unresolved low-confidence fixed event would commit
   unconditionally. **This is new work, not reuse — see "Reused vs. new" and Risk 1.**

## Candidate approaches considered

Divergence (`adhd`, 5 frames — regulator, competitor/attacker, inversion, logistics, remove-the-
load-bearing-assumption) was run on the seam question before reading source in depth, then
converged after: **every frame independently arrived at the same core answer** — treat inclusion
as a real decision the existing lane/hold-back machinery already expresses, never a bespoke
tick-state, never a new taxonomy. Reading the actual code afterward confirmed the convergence was
correct and sharpened it into the specific two-bug diagnosis above, rather than the
speculative "maybe a new `include_candidate` decision-kind" the Designer's spec had flagged as a
live possibility.

1. **New decision-kind (`confirm_create`/`include_candidate`) with its own resolution
   vocabulary** — what the Designer's spec speculatively flagged as "a real Architect-scoped
   change." Rejected once the code was read: `confirm_value` (whole-row, `field: null`,
   `confidence: low/medium`) already exists for exactly this shape and its hold-back already
   works. A second decision-kind would duplicate `reportToLanes`'/`applyResolutions`' switch
   statements for no semantic gain — it would represent the identical fact ("this row is not yet
   approved") in two vocabularies, which is the "second source of truth" the projection ADR's
   invariant exists to prevent, not a seam design.
2. **Thread `chosen`/tick state down as a prop into `ReconciliationScreen`** (Designer spec's F1
   "shape 1," thin-prop option) — keeps two live state trees (`chosen` in `ImportScreen`, `answers`
   in `ReconciliationScreen`) that must stay in sync by hand. Rejected: this is exactly the
   pattern R1/the projection ADR already rejected once (adapter-in-renderer vs. adapter-in-report)
   for the same reason — a hand-synced second state tree drifts. Option A's whole point is that
   there should be *one* tree.
3. **Fix `buildPlan`'s create-confidence bug and remove the pre-filter, reusing `confirm_value` +
   the existing hold-back verbatim** (chosen). Confidence: high. This is not a new mechanism; it
   is un-defeating an existing one at its two actual failure points (the hardcoded `tier: 'new'`,
   and the caller-side pre-filter), then deleting the now-redundant upstream UI that only existed
   to work around the mechanism's absence.
4. **Move `buildPreview`'s classification into a client-side "smart default" that pre-answers each
   decision instead of pre-filtering `approved`** (i.e., keep sending everything to the report, but
   auto-populate `answers[id] = { action: 'looks_right' }` for anything preview.js would have
   ticked) — considered under the inversion frame. Rejected as strictly worse than option 3: it
   reintroduces the exact "two computations of the same fact" duplication (preview.js's frequency
   logic staying separate from `buildPlan`'s confidence tier) that option 3 collapses into one, and
   it makes an "auto-answered" decision indistinguishable in the UI from a director-reviewed one,
   which is a real honesty regression relative to today.

## Decision

**Un-defeat the existing mechanism at its two real failure points, then delete the upstream
surface that only existed to route around it.** No new decision-kind, no new resolution
vocabulary, no new IPC method for the create/update path. One genuinely new mechanism is required
for fixed events (§3 below), and one small additive change each for F2 and F3.

### 1. `buildPlan` gets real confidence on `create` ops

**File:** `src/ingest/buildPlan.js`, the `create` arm (currently line ~325-329, `evidence: {
tier: 'new' }` hardcoded).

`buildPlan` gains one new optional input on `source` — `source.confidence` (or reuse the name
`seenCounts` verbatim if Maker prefers threading the raw frequency data rather than a
pre-classified verdict; either is small): a `{ [entity]: { counts, activityUnitShare } }` shape
matching exactly what `proposal.seenCounts` already carries today (`preview.js:111-113`
consumes this same shape). `buildPlan`'s create arm computes, per candidate name, the identical
test `preview.js`'s `lowConfidence` filter already performs (`looksLikeAMerge` +
`(counts[name] ?? 2) >= 2 || shareOf(name) >= 1`), and stamps:

- `evidence: { tier: 'new' }` — unchanged, when the candidate passes (this stays a genuine
  create, HIGH confidence, silently understood, exactly as it works for a confident candidate
  today).
- `evidence: { tier: 'low' }` — when it does not.

**Move, do not duplicate, the classification function.** `looksLikeAMerge` (and the frequency
test around it) relocates from `preview.js` into `buildPlan.js` (or a shared module both could
import if a future non-`buildPlan` caller needs it — there is none today, so a direct move is the
smaller change per `karpathy-guidelines`). This is the one place `MERGE_RARITY`/the seen-once
judgment should live once `preview.js`'s gating role is gone (§2). Additive-degradation contract:
`source.confidence` omitted (any caller that doesn't pass it — including any test fixture written
before this change) degrades to today's behavior, every create `tier: 'new'`, same as
`fieldProvenance`/`blastRadiusIndex`/`evidenceSupport` already do.

**No change needed downstream of this.** `reconciliationReport.js`'s `classifyItem` create branch
already does the right thing once `tierToConfidence('low')` actually reaches it: `confidence
!== HIGH` → `outcome: 'needsAttention', decision: { kind: 'confirm_value', field: null,
confidence: 'low', proposedValue: null, ... }`. `reportToLanes.js`'s `confirm_value` +
`confidence !== 'high'` mapping already routes it to `standard`. Both are unmodified.

### 2. The antechamber sends everything; the tick UI is deleted, not retooled

**File:** `src/screens/ImportScreen.jsx`.

`readFiles()` (lines 171-311) stops computing `chosen`/initial tick state. `buildPreview()` and
`describePreview()` (`src/ingest/preview.js`) are **deleted** — their gating role is gone (§1
moved the one piece of logic worth keeping), and their `skip`/"already-in-camp" detection is
redundant with `buildPlan`'s own existing-vs-create matching, which already runs on the exact
same `approved` list at commit/dry-run time. `buildCommitInputs()` (lines 445-530) is **retooled,
not deleted**: instead of `approved[entity] = [...(chosen[entity] ?? [])]`, it becomes
`approved[entity] = proposal.entities[entity]` (or the deduped-within-file name list
`extractEntities` already produces) — every name the file offered, unconditionally. The `toggle()`
function, the `chosen` state, and the per-entity tick-list JSX are deleted outright.

`fixedEvents` ticking (`chosenFixedEvents`, `toggleFixedEvent`, `autoAccepts`-gated initial tick,
lines ~260-276) is deleted the same way, **contingent on §3** landing first or in the same slice —
sending every inferred fixed event unconditionally without the hold-back fix would regress
correctness (see Risk 1).

**Retained, unchanged, per the projection ADR's Seam 5 (still correct, this ADR does not revisit
it):** the upload/parse/`extractEntities`/`inferFixedEvents`/`inferActivityRules` flow itself is
the thin antechamber — file selection is a real first step (receiving), and turning bytes into a
structured proposal is not a reconciliation judgment. `groupUnitOverrides`/`activityRules` editing
state and their UI (the per-field EDIT affordance, `updateActivityRule`/`toggleRuleGroup`) are
**kept** — they are resolution mechanisms a `confirm_value`/`confirm_change` decision's "edited"
answer path already uses, not existence-ticks, and `reconciliationResolutions.js`'s
`isEditableDecision`/`EDITABLE_ACTIVITY_FIELDS` already names exactly which fields route through
them. Q8's location-create-defaults-unticked deviation (`ImportScreen.jsx:287-293`, "the one
deviation from every other entity's create-defaults-ticked-unless-low-confidence rule") **folds
into the same mechanism**: a location create simply always classifies `tier: 'low'` in `buildPlan`
(never `'new'`) regardless of frequency, preserving "nothing is ever minted or bound without the
director's explicit tick" as "nothing is ever created without an explicit `looks_right`
resolution in the workspace" — same guarantee, same enforcement point, one mechanism instead of
two.

### 3. New: fixed-event hold-back (the one genuinely new mechanism)

**File:** `src/screens/reconciliationResolutions.js` (`applyResolutions`) and
`src/screens/reconciliationTriage.js` (`foldTriageInputs`).

Today `commitIngest`'s `fixedEvents` array is not filtered by `applyResolutions` at all — only
`approved` is. Once ImportScreen stops pre-filtering `chosenFixedEvents`, every inferred fixed
event (including a `partial`-confidence one, which already produces a `confirm_value` decision via
`addFixedEventDecision`, `reconciliationReport.js:418-428`) would reach the final `commitIngest`
call regardless of whether its decision was resolved, unless this gap is closed.

**Fix, symmetric to the `approved` hold-back:** `applyResolutions` gains a second output,
`fixedEvents` (or `foldTriageInputs` filters `baseInputs.fixedEvents` directly — Maker's call on
which function owns it, the logic is the same either way): for every fixed-event `confirm_value`
decision (`entity === 'anchor_activities'`) that is **not** resolved for the given `answers`, its
named event is removed from the outgoing `fixedEvents` array before the final `apply()` call,
exactly mirroring `reconciliationResolutions.js:95-97`'s existing `nextApproved[entity] =
...filter(n => n !== decision.entityName)`. A fixed event with no `confirm_value` decision at all
(i.e. it classified `understood` — `created`/`unchanged` in `fixedEventsReport`, or `HIGH`
identity confidence) is unaffected and always ships, same as an `understood` entity create always
ships. This is additive to `applyResolutions`'/`foldTriageInputs`' existing shape (a new return
field / a new filter pass), not a new IPC method, not a new decision-kind — but it is genuinely
new logic, not a reuse, and is the one piece of this ADR that needs a dedicated concurrent-write-
style test the way Seam 4's undo mechanism got one (see Test strategy).

### 4. F2 — moved/scope-changed fixed events carry structured `{ from, to }`

**File:** `electron/ops/ingest.js`, the moved-anchor construction (confirmed at the line range the
acceptance test flagged, `~1296-1320` for `moved`, mirrored for `scopeChanged`).

The code already computes `fromDay`/`fromTb`/`toDay`/`toTb` and resolves them to human labels via
`liveName(...)` before formatting them into the `reason` prose string — the values exist in
scope, they are simply discarded once the string is built. Fix: keep them.
`movedBySlot.set(anchorSlotKey(...), { name, reason, from: { day: liveName('days_of_operation',
fromDay), timeBlock: liveName('time_blocks', fromTb) }, to: { day: liveName('days_of_operation',
toDay), timeBlock: liveName('time_blocks', toTb) } })`, threaded through unchanged to where
`fixedEvents.moved`/`fixedEvents.scopeChanged` are attached to the outcome. `reconciliationReport.js`'s
`addFixedEventDecision` (line 216) gains two optional passthrough fields, `from`/`to`, copied onto
the decision object it constructs (additive — a caller/fixture that doesn't supply them gets
`undefined`, and the existing prose-only rendering is the correct degrade). **No location field**:
`anchor_activities` (schema, `electron/db/schema.sql:447-458`) has `day_id`/`time_block_id` but no
location column — the Designer spec's mockup example naming a `Lakefront` location in the from/to
panel does not match the real data model and should be corrected to day + time-block only when
Designer finalizes the F2 visual.

### 5. F3 — a required readiness gap renders as a `hold`-lane card

**File:** `src/ingest/reportToLanes.js`.

No `buildReconciliationReport` change — `report.readiness` already carries everything needed
(`{ key, label, screen, kind, state, message? }`). `reportToLanes` gains a mapping step: every row
where `kind === 'required'` and `state !== 'ready'` becomes a synthetic decision-shaped object,
`{ id: 'readiness:' + row.key, kind: 'required_gap', entity: null, entityId: null, entityName:
null, field: null, confidence: 'required', proposedValue: null, label: row.label, message:
row.message ?? null, screen: row.screen, evidence: null }`, **prepended** to the `hold` array
(ahead of every `resolve_conflict`/`confirm_change` card — a setup gap blocks everything else).
This is a pure re-shaping of data `reportToLanes` already reads (`report.readiness`, consumed
today only for the boolean `readinessGreen`) — no second source of truth.

Dismissal ("Skip for now") is **local UI state only**, exactly matching the roots-spine
kill-switch precedent the R8′ spec cites: a `dismissedGaps: Set<key>` in `ReconciliationScreen`,
never written to `answers`, never folded into `foldTriageInputs`, never sent to `commitIngest`.
`required_gap` decisions therefore never enter the commit payload at all — they cannot, because
nothing downstream (`applyResolutions`, `buildPlan`) has ever heard of `report.readiness` rows as
writable things. `isDecisionResolvedFor` (`reconciliationTriage.js:136`) gets one new branch:
`if (decision.kind === 'required_gap') return dismissedGaps.has(decision.id)` — read from a prop,
not from `answers`, keeping the resolution vocabularies for "commit-affecting decision" and
"session dismissal of a readiness fact" visibly distinct in the code, not just in the UI copy.

### 6. Batching identical-shaped low-confidence creates (the compression requirement)

Rendering-only, no report change. `reportToLanes`'/`report.decisions`' shape stays one row per
candidate — every candidate remains independently traceable and resolvable (the regulator-frame
divergence's strongest and most-repeated finding: admission must stay provable per-row, batching
must not erase the individual record). `ReconciliationScreen` groups **adjacent, same-entity,
same-confidence, `entityId === null`** `confirm_value` decisions in the `standard` lane into one
collapsed row for display — "12 activities seen once — include all / review each" — purely a
rendering fold over the existing array (same precedent as `salienceOf`: a rendering hint, never a
reordering or merging of source-of-truth decisions). "Include all" fires `stage(id, { action:
'looks_right' })` once per grouped decision id, which is the existing per-decision resolution
path called N times, not a new bulk-resolution API. "Review each" expands the group into the
individual `DecisionCard`s already rendered today. This item is UI/Designer-scoped composition,
not an architectural change — named here only so Maker/Designer know the report layer does not
need to change to support it.

## Reused vs. new

**Reused verbatim, unchanged:**
- `reconciliationReport.js`'s `classifyItem` create branch and its `confirm_value`/HIGH-collapse
  rule — already correct, just never fed real confidence.
- `reportToLanes.js`'s `confirm_value` → `standard`/`express` mapping.
- `reconciliationResolutions.js`'s `applyResolutions` hold-back for `approved` (the create/update
  gating mechanism this whole ADR leans on).
- `reconciliationTriage.js`'s `foldTriageInputs`/`stage`/dry-run re-issue loop (Seam 3, unchanged).
- The `groupUnitOverrides`/`activityRules` field-edit UI and its `EDITABLE_ACTIVITY_FIELDS` gate.
- Every IPC call site (`ingestReconcile`, `ingestCommit`) — zero new IPC surface.

**Moved (relocated, not duplicated):**
- `preview.js`'s `looksLikeAMerge`/frequency-based low-confidence test — from `preview.js`
  (consumed only by UI tick-state) into `buildPlan.js`'s create arm (consumed by the report's real
  confidence classification). One function, one call site, instead of a UI-only computation with
  no downstream consumer.

**Genuinely new:**
- `buildPlan`'s `source.confidence` (or `seenCounts`) additive input and its use in stamping
  `evidence.tier` on create ops — small, but it is new plumbing (the seen-count data has to travel
  one hop further than it does today, from `proposal`/`extractEntities` through
  `commitIngest`/`buildPlan`'s existing `source` argument).
- The fixed-event hold-back in `applyResolutions`/`foldTriageInputs` (§3) — no prior mechanism
  exists for this at all; it is not a relocation, it is a genuinely absent piece of logic that
  becomes load-bearing the moment the upstream pre-filter is removed.
- `reportToLanes`'s `required_gap` synthetic-decision mapping (§5) and `ReconciliationScreen`'s
  local `dismissedGaps` state.
- `addFixedEventDecision`'s optional `from`/`to` fields and `ingest.js`'s structured-value capture
  (§4).

**Deleted:**
- `buildPreview`, `describePreview`, `ENTITY_WORD` FROM `src/ingest/preview.js` — the merge-detection
  test relocates (above); the skip/already-in-camp detection is redundant with `buildPlan`'s own
  matching. **NOT the whole file — see amendment A2: `normalizeName`/`recognitionKey` are used by
  10+ modules incl. the live schedule grid and STAY; the file survives (likely renamed).**
- `ImportScreen.jsx`'s `chosen` state, `toggle()`, `chosenFixedEvents`/`toggleFixedEvent`, the
  per-entity and per-fixed-event tick-list JSX, `dualUseActivityNames`/`pinOnlySet`'s tick-gating
  role (the dual-use/pin-only *classification* stays meaningful for activity-catalog defaulting;
  only its role in deciding what gets ticked goes — Maker should confirm at implementation time
  which of Decision 1's consequences survive as a `buildPlan`-side rule vs. genuinely disappear).

## Complexity/risk read and proposed decomposition

This is a large slice touching the live import commit path and the largest screen in the app, but
the core mechanism is smaller than the Designer spec anticipated — it is a bug fix (confidence
tier) plus a deletion (the pre-filter and its UI) plus one real new piece (fixed-event hold-back),
not a new data model. Recommend shipping as **four sequenced sub-slices**, each independently
testable and each leaving the app in a coherent, shippable state:

1. **F3 (required-gap card).** Smallest, zero data dependency, ships first — confirms
   `reportToLanes` changes are safe in isolation before touching the commit path at all.
2. **F2 (moved/scope-changed from/to).** Small, additive, no behavior change to what gets
   written — pure plumbing plus a rendering upgrade. Independent of 3/4.
3. **Create/update confidence + antechamber deletion (§1, §2).** The core of Option A. Test-first
   at the `buildPlan` create-confidence seam before touching `ImportScreen`'s deletions, per
   `karpathy-guidelines`'s "make the seam correct before removing the workaround" discipline —
   land the confidence fix and prove `applyResolutions`' hold-back genuinely gates a low-confidence
   create end-to-end (a real dry-run/commit test, not a unit test of `classifyItem` alone) *before*
   deleting `ImportScreen`'s tick UI, so there is a working fallback state at every commit.
4. **Fixed-event hold-back (§3).** Ships last and only after 3 is verified, specifically because
   it is the one place this ADR introduces logic with no prior working analog — the highest-risk
   piece, isolated so a Red Hat finding here does not block F2/F3/creates from shipping.

Batching (§6) is UI-only and can land whenever Designer schedules it; it has no sequencing
dependency on 1-4.

## ADR required: yes

This changes what `buildPlan`'s create op means (a stored contract other logic — the report,
`reportToLanes`, `applyResolutions` — already depends on via `evidence.tier`), removes an existing
UI/data-flow contract (`ImportScreen`'s tick-then-submit shape) that both a director's mental model
and this codebase's own tests are built around, and closes a correctness gap
(fixed-event hold-back) whose absence is not obviously reversible once the pre-filter it currently
hides behind is removed. Filed at `docs/adr/2026-08-17-onescreen-reconciliation-merge.md`,
extending the projection ADR rather than replacing it — Seams 1-3 and 5 of that ADR are unchanged
by this one; this ADR is additive to it in the same way C4 was additive to Phase C.

## Invariants (carried forward, unchanged, and one addition)

1-3. The projection ADR's three invariants (pure projection, salience never reorders truth, undo
never blind-restores) are unaffected and continue to hold — nothing in this ADR gives the UI a new
way to hold state outside the report/dry-run/`answers` triangle.

4. **New: a decision that was never resolved never reaches a real write.** This is the property
   `applyResolutions`' existing hold-back already gives creates/updates and this ADR extends to
   fixed events (§3) — stated explicitly here because it is the correctness property the whole
   design leans on, and it is exactly the property Risk 1 (below) is testing.

## Risks — flag for Red Hat

1. **Fixed-event hold-back (§3) is new, untested logic on the live commit path — the single
   highest-risk change in this ADR.** Specifically: (a) does removing `chosenFixedEvents`'s
   pre-filter, before the hold-back fix lands, create a window (even a single bad commit during
   development/testing) where every inferred fixed event — high- and low-confidence alike — writes
   unconditionally? The sub-slice ordering (§ Complexity/risk) exists to prevent this reaching a
   real build; Red Hat should confirm the ordering is actually enforced, not just recommended. (b)
   Does the `partial`-confidence fixed-event decision's `entityName` (used to filter `fixedEvents`
   by name) collide with two *different* anchors sharing the same event name on different days —
   i.e. is name a safe-enough key for the hold-back filter, or does it need the day/time-block
   discriminator `fixedEventKey` (`ImportScreen.jsx`, used for today's `chosenFixedEvents` Set) 
   already uses?
2. **`buildPlan`'s new `source.confidence` input threading (§1) has to travel from
   `proposal.seenCounts` (computed at parse time, client-side) through `commitIngest`'s existing
   `source` construction (`electron/ops/ingest.js:499-524`) into `buildPlan`'s create arm — confirm
   this data survives the S4b workbook-reimport path unchanged** (that path builds its own
   `source.approved` directly from a parsed enrichment workbook, `ImportScreen.jsx:320-346`,
   without going through `extractEntities`/`buildPreview` at all — it has no `seenCounts` today and
   must not gain a spurious low-confidence classification for having none; confirm the additive
   default, "no confidence data -> `tier: 'new'`," is what actually happens for that path, not an
   accidental `tier: 'low'` degrade because `seenCounts` is empty rather than absent).
3. **Deleting `preview.js`'s `skip`/already-in-camp detection removes the antechamber's ability to
   say "N rows are already in your camp" before the workspace loads.** Confirm this information is
   not silently lost — it should reappear as the report's own `understood`/`buckets.understood`
   count once the dry-run runs (the workspace already shows this), but there is a moment (file
   selected, dry-run not yet returned) where the old screen had an instant local answer and the new
   one has a loading state. Acceptable per this ADR's read of the design, but worth Red Hat
   confirming the loading state doesn't read as "nothing happened."
4. **Q8's location-create-defaults-unticked deviation folding into `tier: 'low'` (§2) changes
   *how* the guarantee is enforced but must not change *what* it guarantees** — confirm no path
   exists where a location candidate reaches `tier: 'new'` (and therefore silently creates) by
   omission, e.g. a location name that also happens to pass the frequency test that would make an
   *activity* candidate `tier: 'new'`. The fix as specified hardcodes locations to always classify
   `'low'` regardless of frequency, which should prevent this, but it is exactly the kind of
   "harmless-looking except for one entity" special case Red Hat's adversarial pass exists to catch.
5. **Behavior parity with the shipped flow** — the acceptance test's "118 facts -> 0 forced
   decisions on a clean import" number must not regress. A clean re-import of the SAME file (every
   name already `unchanged`) must still classify `outcome: 'unchanged'` for every row, never
   `create`/`confirm_value` — confirm the confidence-tier change (§1) only touches the `create` arm
   and cannot leak into the `unchanged`/`update` classification paths.

## Test strategy

- **`buildPlan` create-confidence:** unit tests, table-driven, over the exact
  `looksLikeAMerge`/`seenCounts`/`shareOf` fixtures `preview.test.js` (if it exists) already has —
  moving the function should move its test coverage, not leave a gap. Assert `tier: 'new'` for a
  confident candidate, `tier: 'low'` for a seen-once one, `tier: 'low'` unconditionally for
  `entity: 'locations'`.
- **End-to-end hold-back (the load-bearing test, per handoff §23's behavior-level discipline):** a
  dry-run/commit test that (a) proposes a low-confidence create, (b) confirms it appears as a
  `confirm_value` decision in `standard`, (c) commits with that decision **unresolved**, and
  asserts the candidate was **not** written, (d) resolves it `looks_right`, re-commits, and asserts
  it **was** written. Repeat the same four-step shape for a low-confidence fixed event once §3
  lands — this is the test that proves Invariant 4, not just documents it.
- **Regression:** the acceptance-test harness itself
  (`scratchpad/reconcile-acceptance.mjs`, referenced in the acceptance-test run record) re-run
  against the same `prior-year.xlsx` fixture, asserting the "0 forced decisions on a clean import,
  1 on a changed one" numbers still hold post-change (Risk 5).
- **F2:** `addFixedEventDecision`/`reconciliationReport.test.js` fixture asserting `from`/`to`
  pass through onto the decision when present, and are `undefined` (not a crash, not a stringified
  `null`) when absent.
- **F3:** `reportToLanes.test.js` fixture: a `readiness` row with `kind: 'required'`,
  `state: 'missing'` produces a `required_gap` decision prepended to `hold`; a `state: 'ready'` row
  produces nothing; an `optional`-kind row is unaffected (still only folds into
  `buckets.notInSource` as today).
- **S4b workbook-reimport parity (Risk 2):** an existing or new test confirming that path's
  `source` (no `seenCounts`) still classifies every create `tier: 'new'`, unchanged from today.

## Red Hat review amendments (2026-08-17) — BINDING on the affected sub-slices

Red Hat reviewed this ADR's risk surface (Resilience 3/5 — approach sound, sub-slices 3/4
reshaped). The core create-confidence mechanism (§1) and its isolation from unchanged/update
(Risk 5) are structurally confirmed. Five findings, all folded in here:

**A1 (HIGH — prerequisite to §3/sub-slice 4). Fixed-event decisions collapse distinct anchors by
name BEFORE the hold-back can act.** `fixedEventDecisionId` (`reconciliationReport.js:204-209`) and
`addFixedEventDecision` key by `(kind, reason, name)` only, and `fixedPartial`/`fixedMoved`/
`fixedScopeChanged` pushes (`electron/ops/ingest.js:1331-1415`) carry no day/time-block. So two
`partial` "Free Swim" anchors on different days merge into ONE decision, discarding the second's
identity — a name-keyed hold-back filter then writes both or drops both. **Fix (prerequisite step
inside sub-slice 4, before the hold-back filter): `fixedEventDecisionId` keys on the day/time-block
discriminator `ImportScreen.jsx:45`'s `fixedEventKey` already uses (`name + time_block +
days.join(',')`), and the `fixedPartial`/`fixedMoved`/`fixedScopeChanged` pushes carry
`time_block`/`days` through so the report can build that key.** This also un-collapses the UI so
both candidates surface as distinct cards. Sub-slice 4 does NOT start until this lands.

**A2 (MED-HIGH — corrects §2/Deleted, prevents a Maker misread). `src/ingest/preview.js` is a
load-bearing utility module, not just a UI-preview module.** It also exports `normalizeName` and
`recognitionKey`, imported by 10+ modules including the live schedule grid
(`useSlotMutations.js`, `CellInlineEditor.jsx`) and the whole ingest pipeline. **Only
`buildPreview`, `describePreview`, `ENTITY_WORD` leave; `normalizeName`/`recognitionKey` STAY (the
file survives, likely renamed since "preview" no longer describes its contents), and
`looksLikeAMerge` MOVES into `buildPlan.js` per §1.** Do NOT delete the file.

**A3 (HARD BLOCKER on sub-slice 3 — promotes Open Question 2). `pinOnlySet`'s only consumer is the
deleted tick line** (`ImportScreen.jsx:293`). Deleting §2's tick UI without a `buildPlan`-side
replacement drops the guard that stops a pin-only fixed-event-name activity from silently minting
as a catalog activity (ADR 2026-08-09 Decision 1) — it could reach `tier: 'new'`/silent create.
**Resolve OQ2 (carry the pin-only/dual-use rule to a `buildPlan`-side classification) IN sub-slice
3, same slice as the deletion — not "at implementation time." If it needs real redesign rather
than a carry-over, escalate to Governor before deleting.**

**A4 (LOW-MED — own the behavior change). S4b enrichment-workbook location creates now require
review too.** §2's Q8 fold (locations always `tier: 'low'`) fires on the S4b path (which has no
`seenCounts`), so a routine enrichment reimport that adds one new location now surfaces a
`confirm_value` decision it didn't before. By design (the hold-back protects it), but a workflow
change — Designer/Tester must check it, not discover it as a regression.

**A5 (LOW — confirms Risk 5, adds a guard test). `emitCreate` is the only tier-'new' site;
`emitRecognized` (update/unchanged) uses HIGH identity tiers independently** — Risk 5 holds AS LONG
AS the new frequency check is added ONLY inside `emitCreate`. **Add a test: a name that appears as a
create-candidate AND resolves `unchanged` (in `existing`), with `seenCounts` marking it
low-confidence, still reports `tier: 'exact_name'`/HIGH — never `'low'`.** Do not generalize the
frequency check into a shared helper both arms call.

## Open questions for Governor

1. **Exact naming of `buildPlan`'s new confidence input** (`source.confidence` vs. `source.seenCounts`
   passed raw) — technical either way, Maker's call within this ADR's mechanism.
2. **Whether `dualUseActivityNames`/`pinOnlySet`'s Decision-1 pin-only rule (activity-catalog
   defaulting, distinct from create/skip ticking) survives as a `buildPlan`-side rule or needs its
   own small follow-up** — flagged in "Reused vs. new" as something Maker should confirm at
   implementation time; if it turns out to need real redesign rather than a straightforward carry-
   over, that is a scope question for Governor, not something to resolve mid-implementation.
3. **Batching UI (§6) exact grouping threshold and copy** ("12 activities seen once — include all?
   review each?") is Designer's call, not architectural — flagged here only so Designer knows the
   report layer needs no change to support it.
4. **Sequencing approval** — this ADR recommends F3 → F2 → creates → fixed-events as four
   sub-slices (see Complexity/risk read). Confirm Governor wants them as four separate Maker
   briefs/PRs rather than one large one; the ADR's risk analysis assumes they ship in that order
   with fixed-events verified last and independently.
