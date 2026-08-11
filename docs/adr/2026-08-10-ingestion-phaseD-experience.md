---
title: "ADR: Ingestion Phase D — Experience (reconciliation summary, decision resolution, why-disclosure, readiness integration)"
status: proposed
date: 2026-08-10
decided: null
deciders: [product-owner]
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md]
supersedes: []
extends: [docs/adr/2026-08-10-ingestion-reconciliation-semantics.md, docs/adr/2026-08-10-ingestion-phaseC-compression-layer.md]
depends_on_external: []
related_discovery: docs/work/specs/2026-08-09-ingestion-reconciliation-brief.md
program: ingestion-reconciliation
---

# ADR: Ingestion Phase D — Experience

Sub-ADR under the parent (`docs/adr/2026-08-10-ingestion-reconciliation-semantics.md`), covering the
brief's **PHASE D — EXPERIENCE** (`docs/work/specs/2026-08-09-ingestion-reconciliation-brief.md`,
"IMPLEMENTATION ORDER"): *"reconciliation summary → focused decision resolution → progressive 'why?'
evidence → Setup Readiness integration."* This is a design document only — no product code, no build.
A Designer mockup pass should follow before any Phase D build (see "Designer pass" below).

## Premise verification (re-checked against `work/ingestion-phasec` on main `52ecf5e`)

The program's premises have drifted four times before, so every claim below is grounded in a specific
`file:line`, not carried over from an earlier phase's summary.

- **`buildReconciliationReport` exists, is fully shipped (C1–C4), and is called by NOTHING outside its
  own test file.** `grep -rn "buildReconciliationReport" electron/ src/` (excluding
  `reconciliationReport.js` and `reconciliationReport.test.js`) returns zero matches. This is the
  central Phase D finding: **Phase D's first job is wiring, not just rendering** — nobody currently
  builds the input object (`planItems`, `fixedEventsReport`, `readiness`, `legacyPriorityActivities`,
  `fieldProvenance`) and calls the function. `buildFieldProvenanceMap` (`electron/ops/ingest.js:365`)
  is also shipped and likewise uncalled outside its own tests.
- **Today's parse→commit flow, concretely** (`src/screens/ImportScreen.jsx`):
  1. File upload → parse → local state (`preview`, `fixedEvents`, `activityRules`, etc., lines
     127–193).
  2. `commit()` (`:611`) calls `stageLedger(buildCommitInputs(), ...)` (`:597`), which runs the
     **client-side dry-run**: `buildExistingSnapshot` + `foldApprovedToRecords` +  the pure `buildPlan`
     (`:602`) — this produces a `ReconciliationPlan` (`plan.items`, CRUD-shaped: `create` / `update` /
     `unchanged` / `clear` / `conflict`), stored in `ledger` state (`:608`).
  3. `<ReconciliationLedger plan={ledger.plan} .../>` renders it (`:832`) — **grouped by CRUD op**, not
     by confidence/bucket. Sections: `unchanged` (collapsed count), `updated` (open, field diffs),
     `cleared` (open, firmer framing), `new` (collapsed count), `conflict` (always open, gates commit).
     This is the "CRUD-grouped ledger" the task description names — real, but it does **not** speak in
     the brief's UNDERSTOOD / NEEDS ATTENTION / NOT IN SOURCE / CHANGED vocabulary, nor does it use
     `buildReconciliationReport` at all (it renders `plan.items` directly).
  4. `onCommit` → `runCommit(ledger.context)` → `localClient.ingestCommit` (electron IPC) → the atomic
     `commitIngest`/`commitPlan` main-process transaction. If the commit re-holds on a conflict,
     `held` state is set (`:788` region) and **`HeldResolution`** (`:1233`) renders — a genuine
     one-at-a-time decision queue (`deriveQueue`, `:100`; `currentId`/`seen` state, `:1240–1241`;
     `IdentityCard`/`StaleCard`/`FinishCard` per-conflict-type cards, `:1437/1501/1551`) with "Review N
     items" entry (`:806`), "Not now" deferral (`:809`), and a single `finishHeld` (`:623`) that
     re-submits the **whole** plan plus resolutions through the same atomic commit.
  - **This `HeldResolution` component is the one existing precedent for "focused decision resolution"
    in this codebase** — it already does one-at-a-time navigation, defer/return, and folds resolutions
    into a single all-or-nothing commit. Phase D's decision-resolution UI (D2) should be read as
    **generalizing this existing pattern to Phase C's four `decision.kind` values**, not inventing a
    new interaction model.
  - `IdentityCard` (`:1437`) already reads `item.conflict.evidence?.candidates` and renders it inline —
    the one existing "why" precedent, though not click-to-expand/progressive; Phase D's why-disclosure
    (D3) generalizes this into an on-demand pattern keyed to Phase C's `evidence: {entity_type,
    entity_id, field}` handle instead.
- **`ActivityRuleRow` (`ImportScreen.jsx:1592`) is the other form-dump surface** — per-activity
  frequency/priority/eligible-groups controls, expandable (`expanded` state, `:1593`), rendered inline
  in the pre-commit review area (referenced at `:1011`). It is upstream of `buildPlan`/the ledger (it
  edits the inputs the plan is built from), not itself part of the ledger — it stays as the "Edit"
  destination a Phase D proposal card routes to, not something Phase D replaces wholesale (see D1/D2
  below).
- **`listImportEvidence(db, camp_id, {entity_type, entity_id})`** (`electron/ops/ingest.js:296`) →
  rows `{..., support: <parsed JSON>}`, confirmed signature, confirmed live (tested at
  `electron/ops/ingest.test.js:1073` etc.). No `field` filter param today — the function narrows by
  `entity_type`/`entity_id` only; a Phase C `evidence` handle also carries `field`, so the caller
  filters the returned rows by `field` client-side (cheap: evidence rows per entity are few). Not a
  premise break, just a shape note for D3's implementation.
- **Setup Readiness** — `src/engine/readiness.js:177` `getReadiness(collections, signals)`, six-state
  (`ready / needs-attention / missing / optional / not-applicable / in-progress`), `OPTIONAL_AREAS`
  (`:76`) and `FORWARD_AREAS` (`:137`) structurally capped at `optional`. **`ReadinessHub.jsx` is
  already the designated integration seam and says so explicitly**: its own file-header comment
  (`:9–12`) reads *"The reconciliation-preview ledger (§7) is a separate slice (S5b/T75) and is not
  built here; with no live plan, categories rest at Ready / Missing / Optional."* This confirms D4's
  destination without any new screen — `ReadinessHub` was built anticipating exactly this extension.
- **Commit path is confirmed all-or-nothing, compatible with "resolve one, return to summary."**
  `finishHeld` (`ImportScreen.jsx:623`) already demonstrates the shape Phase D needs: local UI state
  tracks which decisions are resolved; one `resolutions` array accumulates; a single commit call fires
  once, at the end. Nothing in Phase C or the live commit path requires or enables partial/incremental
  commit — confirmed compatible with the brief's "resolve one decision, return to summary" without any
  IPC change.

**No premise is stale.** Phase C's output is real, correct per its own tests, and simply not yet
consumed. That absence of a caller is Phase D's foundational fact, not a blocker.

## The report-destination design (D1)

Replace `ReconciliationLedger`'s CRUD framing with a **reconciliation summary** rendered from
`buildReconciliationReport`'s `{buckets, decisions}`, still fed by the same `stageLedger` moment
(post-parse, pre-commit) so nothing about *when* the report is computed changes.

```
Shoresh reconstructed your camp from last year's schedule.

  ✓ 374 understood
  ⚠ 4 need your attention
  ○ 2 optional areas not in this source
  ↻ 7 changed from what's already set up

  [ Review 4 decisions ]                 [ Commit everything else now ]
```

- **`understood`** renders as a single line (count only — no per-row list; this is the "reassuring
  majority collapses to a count" principle the existing ledger already applies to its `unchanged`
  section, carried forward).
- **`changed`** groups by the domain categories the brief asks for ("derive the exact categories from
  the actual Shoresh domain model, not these examples") — concretely, `decision.entity` gives this for
  free: `activities` / `anchor_activities` / `groups` / etc. map onto the screens/setup areas a director
  already knows (Activities, Fixed Events, Groups...). No new taxonomy invented; reuse the entity→screen
  mapping `readiness.js`'s `REQUIRED_AREAS`/`OPTIONAL_AREAS` already carries (`label`, `screen` fields).
- **`notInSource`** renders as a readiness-flavored line, not a list of `decisions[]` (there are none —
  Phase C's design leaves this bucket-only by owner decision). Each contributing readiness row
  (`state === 'optional'`) gets its label and an affordance mirroring the brief's example: an
  "Add/Configure" link to the row's `screen`, no forced action. This is where D4's integration actually
  lives inside D1's summary, not a separate screen.
- **"Review N decisions"** is the one primary call to action, matching the brief's "Review 4 decisions,
  NOT review your camp." Clicking it enters D2's decision queue. A secondary "Commit everything else
  now" path — commit is still all-or-nothing per the parent ADR, so this button's real behavior is
  "commit now, including default/no-op treatment of whatever decisions remain unresolved" — **this is
  an open question below (OQ1)**, because Phase C's decisions currently have no defined behavior when
  left unresolved at commit time.
- **What happens to `ReconciliationLedger`**: not deleted. Its CRUD-diff rendering (`FieldDiff`,
  `LedgerSection`, the `cleared`-gets-its-own-firmer-framing pattern) is exactly the right shape for the
  **evidence/detail view inside a decision card** (D2) and for an "advanced details" escape hatch the
  brief explicitly permits ("open advanced details on demand"). Concretely: keep the component, repoint
  its consumer — instead of being the primary post-parse destination, it becomes the content of an
  optional "see everything" expansion below the summary, and/or the render target `HeldResolution`-style
  decision cards reuse for their own "what exactly changes" detail. This reuses real, tested code rather
  than discarding it.
- **What happens to `ActivityRuleRow`**: unchanged as a component. It remains the destination an "Edit"
  action on a `confirm_value`/`confirm_change` decision card routes to (pre-existing behavior: it edits
  the inputs `buildPlan` diffs against). Phase D does not touch its internals.

## Focused decision resolution (D2)

Generalize `HeldResolution`'s existing one-at-a-time queue (`ImportScreen.jsx:1233–1591`) from
"conflicts only" to all four `decision.kind` values Phase C emits (`resolve_conflict`, `confirm_value`,
`confirm_change`, `review_legacy_priority`), keyed by Phase C's stable `decision.id`.

- **Card shape**, per the brief's "Looks right / Edit" pattern — one card per `decisions[]` entry:
  - Header: `entityName` + a one-line summary derived from `kind` + `reason` (all real strings already
    produced by `buildPlan.js`/`ingest.js` — Phase C's own non-goal is "no new copy invented at this
    layer," and Phase D should hold the same discipline: reuse `reason` verbatim, do not re-word it).
  - Body: the proposed value(s) — `field`/`proposedValue`, rendered with the *same* `FieldDiff`/`fmtVal`
    formatting `ReconciliationLedger` already has (was → will-be, `(cleared)`, `(empty)` sentinels).
  - `unknowns` (when populated by a future slice — C1 does not populate it yet, see Phase C's own
    module doc) render as a quiet "not sure yet" note, never a blocking field.
  - Actions: **`kind`-dependent**, but converging on two buttons wherever possible:
    - `confirm_value` / `confirm_change` / `review_legacy_priority`: **Looks right** (accept
      `proposedValue` as-is) / **Edit** (routes to the relevant setup screen — `ActivityRuleRow`'s
      inline edit for activity fields, or the entity's setup screen for others — then returns to the
      queue).
    - `resolve_conflict`: keeps its existing `IdentityCard`/`StaleCard` per-`reason` treatment
      (`missing_target` / `alias_divergence` / `ambiguous_identity`) verbatim — these already have a
      correct, tested UI; Phase D folds them into the same queue shell rather than replacing them.
    - `review_legacy_priority` (batched, per Phase C's C2b resolution): one card represents the whole
      batch (`count`, `activities: [{entityId, name}]`) — "N activities carry a priority Shoresh never
      confirmed" with a **Review each** action that opens a lightweight per-activity sub-list (reusing
      `ActivityRuleRow`'s existing priority control), not N separate top-level cards. This keeps the
      queue length equal to the brief's "4 decisions," not "4 decisions plus 12 legacy-priority rows."
- **Navigation**: one card visible at a time (current `HeldResolution` pattern), progress indicator
  ("2 of 4"), Next/Back, and — new relative to `HeldResolution` — **"Return to summary"** at any point
  (the brief's explicit "resolve one decision, return to summary" and "leave and return later"
  requirements). Resolving a card updates local `resolutions` state (same shape `finishHeld` already
  assembles) and decrements the summary's `needsAttention` count live; it does **not** commit
  individually.
- **Wiring to the pending plan / commit**: unchanged mechanism. Each resolution folds into the same
  `resolutions ?? []` array `buildPlan`'s third argument already accepts (`stageLedger`,
  `ImportScreen.jsx:605`) and `finishHeld`'s existing re-submit path. The **one** commit fires when the
  director explicitly commits — from the summary (D1's "Commit everything else now") or from the queue
  once all decisions are resolved. No partial-apply primitive is introduced (Phase C's own non-goal,
  carried forward unchanged).
- **Leave and return**: since nothing commits until the explicit commit action, "leaving" the queue mid
  review is just closing the resolution UI and returning to the summary — `ledger`/`held`-shaped state
  (already `useState` in `ImportScreen`) persists resolved answers for the remainder of the session,
  same as `dismissHeld`'s existing "Not now" already does for conflicts today (`:809`, `:678`). Surviving
  a full app restart mid-review is out of scope (same as today — the existing ledger/held state is
  session-only, not persisted).

## Progressive "why?" disclosure (D3)

- Each decision card gets a quiet, secondary **"Why does Shoresh think this?"** affordance — visually
  subordinate to Looks-right/Edit (per DESIGN_STANDARD's restraint principle and the brief's "does NOT
  occupy the primary interface").
- On click: dereference `decision.evidence` (`{entity_type, entity_id, field}`) via
  `localClient`'s IPC wrapper around `listImportEvidence(db, camp_id, {entity_type, entity_id})`
  (`electron/ops/ingest.js:296`), then filter the returned rows client-side to the matching `field`
  (confirmed: the IPC signature has no `field` param, so this filter step belongs to the D3 caller, not
  a new IPC surface — no electron/main.js change needed).
- Render as an inline expansion under the card (not a modal — keeps the queue's one-at-a-time rhythm
  intact), showing the evidence's `support` payload in plain language: which source rows/observations
  produced this inference. `IdentityCard`'s existing `item.conflict.evidence?.candidates` rendering
  (`ImportScreen.jsx:1438`) is the closest existing precedent for turning a raw evidence shape into
  director-legible text — reuse its formatting conventions rather than inventing new ones.
- **Decisions with `evidence: null`** (every `kind` today — Phase C's own module doc: "C1 does not build
  UNKNOWN-field detection — deferred"; fixed-event and legacy-priority decisions also carry
  `evidence: null` by construction) get **no** why-affordance rendered at all, rather than a disabled or
  empty one. This is a **real, current gap worth naming plainly**: Phase C ships the `evidence` field in
  its output shape, but no slice populates it with a non-null handle yet for any decision kind. D3 is
  therefore buildable and correct today (it renders nothing, honestly, for every current decision), but
  its payoff is deferred until a future Phase C slice (not scoped here) starts populating `evidence`
  per-decision. Flagged as OQ2 below.

## Setup Readiness integration (D4)

- `ReadinessHub.jsx` already has the "no live plan" resting state (`Ready / Missing / Optional`,
  `:9–12`'s own comment) and is the confirmed seam. Two integration points, both additive to
  `ReadinessHub`'s existing six-state model — no change to `getReadiness`'s signature or state machine:
  1. **Post-import, `ReadinessHub` can show the same `notInSource` framing D1's summary shows** — since
     both read the identical `getReadiness()` output, this is a rendering choice (same "not in source"
     line, reachable from two places: right after import, and any time later from the Readiness hub),
     not a second readiness computation.
  2. **Required-vs-optional stays exactly as `readiness.js` already enforces it**: `REQUIRED_AREAS` (a
     missing one is `missing`, blocks the schedule-generation gate) vs. `OPTIONAL_AREAS`/`FORWARD_AREAS`
     (structurally capped at `optional`, per `readiness.js:137`'s comment, "can NEVER reach Missing").
     Phase D adds no new area, no new state — it only makes sure the reconciliation summary's
     `notInSource` bucket and `ReadinessHub`'s existing `optional` rows read as the same fact
     ("Locations not configured" said once, consistently, in both places), per the brief's "Ready to
     build a week. AND Locations have not been configured."
- No change to `readiness.js` itself is proposed. This is presentation wiring, not a domain change.

## D-slice decomposition (dependency order)

- **D1 — wire + render the summary buckets, read-only.** Build the `buildReconciliationReport` input
  object at the `stageLedger` call site (`ImportScreen.jsx:597`) — `planItems` from the existing `plan`,
  `fixedEventsReport`/`readiness`/`legacyPriorityActivities`/`fieldProvenance` newly assembled (the
  latter two via `electron/ops/ingest.js`'s already-shipped-but-uncalled helpers, surfaced through a new
  thin IPC read or folded into the existing preview call — **implementation detail for Maker, not an
  architectural choice this ADR needs to pin down**, since both are read-only). Render the four-bucket
  summary in place of/alongside `ReconciliationLedger`'s current top-level framing. **No interaction
  yet** — "Review N decisions" can be a disabled/placeholder button. This is the first buildable slice:
  it has a completely mechanical seam (Phase C's function signature is closed and tested) and produces
  visible value (the actual bucket counts) on its own. **First buildable D-slice.**
- **D2 — decision cards + resolution**, depends on D1 (needs `decisions[]` rendered and a real "Review N"
  entry point). Generalizes `HeldResolution`. Independent of D3/D4.
- **D3 — why-disclosure**, depends on D2 (needs a card to attach the affordance to). Independent of D4.
  Given the evidence-population gap named above, D3's actual near-term value is limited until a future
  Phase C slice populates non-null `evidence` handles — Governor may choose to sequence D3 after that
  slice exists rather than immediately after D2, but the UI work itself has no other blocker.
- **D4 — readiness integration**, depends on D1 only (reads the same `readiness` input D1 already
  assembles). Can build in parallel with D2/D3.

Order: **D1 → {D2, D4 in parallel} → D3** (D3 nominally depends on D2's card shell but its payoff
depends on a Phase C evidence-population slice not yet scoped).

All four slices are UI + thin caller-side glue (assembling Phase C's input object, filtering evidence
rows by field) — no new domain logic anywhere in Phase D, consistent with "Phase D consumes Phase C, it
doesn't re-implement it."

## Non-goals

- **No incremental/partial commit.** All-or-nothing stays, per the parent ADR and Phase C's own
  non-goals. "Resolve one decision, return to summary" is a *review-surface* affordance over local
  state, not a partial-write primitive — stated plainly per the task's instruction.
- **No MCP/CLI.** Out of scope per the brief.
- **No mandatory wizard.** The summary is always reachable and dismissible; high-confidence
  (`understood`) rows are never re-surfaced for confirmation.
- **No new domain logic.** Phase D calls `buildReconciliationReport` and `listImportEvidence` as they
  exist today; it does not add new classification rules, new confidence tiers, or new Phase-C output
  fields. If D3's evidence-population gap needs closing, that is a Phase C slice, briefed separately.
- **No IPC signature change.** `listImportEvidence` is used as-is; field-filtering happens in the
  renderer.
- **No change to `readiness.js`, `buildPlan.js`, `confidence.js`, or the commit path's transaction
  shape.**
- **Scope control per the brief**: no full staffing/electives UI, no GIS/map screen, no replacement of
  working ingestion machinery beyond the two named surfaces (`ReconciliationLedger`'s top-level framing,
  the post-conflict-only scope of `HeldResolution`).

## ADR required: yes

This is a sub-ADR per the parent program's own practice (each phase gets one), filed at
`docs/adr/2026-08-10-ingestion-phaseD-experience.md`. It does not itself introduce a new persistent data
shape or change a stored schema, but it does fix the contract for a screen/flow other code (and future
Phase E validation, and any future Phase C evidence-population slice) will depend on, and it makes one
tradeoff that is not obviously reversible without rework: keeping `ReconciliationLedger`'s CRUD view as
a secondary/detail surface rather than deleting it. Consistent with this program's practice of a sub-ADR
per phase (Phase C got one for a comparably-scoped pure-function design), this is filed as one rather
than folded into a plain spec doc.

## Open questions for Governor / product owner

1. **What happens if the director commits from the summary ("Commit everything else now") while
   decisions remain unresolved?** Today's `HeldResolution` conflicts *gate* the commit entirely (cannot
   commit while any conflict stands, `ReconciliationLedger.jsx:190`). Phase C's non-conflict decision
   kinds (`confirm_value`, `confirm_change`, `review_legacy_priority`) have no defined default: does
   leaving one unresolved mean (a) it still gates commit like a conflict does today, (b) the plan commits
   with the *proposed* value applied by default, or (c) the plan commits with that field held back
   (skipped) until resolved later? This is a product decision Phase D's D2 build cannot proceed cleanly
   without, since it changes both the summary's secondary-action wording and D2's queue-completion
   behavior.
2. **Evidence-population gap**: every current decision kind carries `evidence: null`. Is closing this
   (a small, additional Phase C-shaped slice — populating the `evidence` handle at decision-construction
   time in `reconciliationReport.js`) in scope for this program before D3 ships, or should D3 ship now as
   a no-op-for-every-current-decision affordance and the evidence-population work be tracked as a
   separate, later ticket? Recommend the latter (ship D3's UI shell now, since it costs nothing extra and
   is immediately useful once evidence starts populating) but this is the product owner's call on
   sequencing, not a technical one.
3. **`review_legacy_priority`'s "Review each" sub-list** — does resolving individual activities inside
   the batch card need its own progress state distinguishable from the top-level decision queue's "N of
   4," or is it acceptable for the whole batch to count as "resolved" once every activity inside it has
   been looked at (all-or-nothing at the batch level, matching Phase C's own batching choice)? Affects
   D2's card-state model for this one `kind`.

## Designer mockup pass

**Recommended: yes**, before any Phase D build. Specifically:
- The summary layout (D1) — bucket ordering, iconography/glyphs (the existing `✓`/`⚠`/`○`/`↻`-style
  vocabulary `ReconciliationLedger.jsx` already uses is a strong starting point, per DESIGN_STANDARD
  consistency), and how "Review N decisions" reads next to the secondary commit action once OQ1 is
  resolved.
- The decision card (D2) — specifically how a `confirm_change` (director-confirmed field being
  overwritten) reads distinctly firmer than a routine `confirm_value`, mirroring how
  `ReconciliationLedger`'s `cleared` section already earns its own firmer visual treatment relative to
  `updated`.
- The why-disclosure's inline-expansion motion/placement (D3), consistent with the schedule grid's
  existing progressive-disclosure conventions.
No mockup needed for D4 (readiness integration is copy/data wiring onto an existing, already-designed
screen).
