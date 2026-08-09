---
title: "Fixed-event catalog routing and reviewable, provenance-protected units"
document_type: adr
authority: normative
status: proposed
date: 2026-08-09
supersedes: []
implementation_state: not-started
affects:
  - src/ingest/extractEntities.js
  - src/ingest/fixedEvents.js
  - src/ingest/buildPlan.js
  - src/ingest/fieldUpdate.js
  - src/screens/ImportScreen.jsx
  - electron/ops/ingest.js
  - electron/ops/ingest.golden.test.js
  - src/ingest/daysheet.test.js
related_adrs:
  - docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md
  - docs/adr/2026-08-03-ingesting-recurring-fixed-events.md
  - docs/adr/2026-08-08-s1a-import-recognizes-existing-entities.md
  - docs/adr/2026-08-08-s2a-field-provenance-and-hand-edit-protection.md
  - docs/adr/2026-08-08-s2b-field-level-update-and-stale-conflict.md
  - docs/adr/2026-08-08-t72-fixed-event-reimport-idempotency.md
---

# Fixed-event catalog routing and reviewable, provenance-protected units

**Status: PROPOSED.** Two product-owner decisions (2026-08-09), both resolved here into a design a
Maker can execute without further architectural judgment calls:

1. A fixed event pinned to a period must **not** also create a free-choice catalog activity, unless
   the same name is genuinely used both ways — in which case it becomes a reviewable exception, not
   a silent double-write.
2. A group's **unit** must be inferred better where the file can encode it, made an editable field in
   import review where it can't, and — the hard part — a director's hand-assigned unit must survive a
   later re-import exactly the way every other hand-edited field already does (Policy A, S2b).

Decision 1's routing lives entirely in `ImportScreen`'s review-tick seeding and leaves `buildPlan`'s
`source` contract untouched (see below — this was tightened after Red Hat review). Decision 2 DOES touch
that contract (a new `humanEditedFields` key) and extends the write-time provenance rule S2a/S2b
established — a not-obviously-reversible choice about which fields commit-time writes stamp as
`'human'` versus `'import'`. Decision 2 alone clears the ADR bar on contract/provenance grounds; Decision
1 clears it because routing a pinned name away from the catalog by default is a durable, camp-visible
behavior change or a future engineer would otherwise "fix" as a bug — recorded here for the same reason
any deliberate, non-obvious default belongs in an ADR.

---

## Context

**Decision 1's bug, verified against the code.** `extractEntities` (`src/ingest/extractEntities.js`)
proposes every activity-like cell value as a catalog `activities` candidate (~lines 293–304, tallied
into `entities.activities`), with no awareness of `fixedEvents.js`. `fixedEvents.js`'s `inferFixedEvents`
independently walks the SAME cells and proposes `anchor_activities` rows for names that are pinned to
the same period on a majority of a group's operating days (~104–127). Nothing subtracts one proposal
from the other: `buildPlan.js`'s entity loop (~143) and `commitPlan`'s `commitCreate` (`electron/ops/
ingest.js` ~560–622) write `activities` rows for every ticked catalog name regardless of whether that
same name is also a ticked fixed event, and the fixed-event loop (~827–896) writes the `anchor_activities`
rows independently. A pinned name like "Lunch" or "Mifkad" ends up as both a catalog activity a
director can freely schedule anywhere AND a pinned anchor — the free-choice row is simply wrong for a
name that is never actually a free choice in the source file.

**Decision 2's bug, verified against the code.** `extractEntities` has two inference paths for a
group's unit, both incomplete:

- **Groups-are-columns orientation** (`orientation.columns !== 'days'`, ~267–269): `groups.push(...
  page.columns.map((c) => ({ title: c, unit: null, group: c })))` — unit is hardcoded `null` for
  every group. This is the one-page-per-day layout; the column header IS the group/bunk name, and
  today nothing tries to read a unit out of it.
- **Groups-are-pages orientation** (`orientation.columns === 'days'`, ~261–263): unit comes from
  `splitUnitAndGroup(title)` (a "Unit - Bunk" title) when `page.timeColumnLabeled !== false`, or from
  `inferUnitFromCode(title)` (a positional code like "KA") when it IS `false`. A title that has
  neither shape — no separator, not a code — falls through `splitUnitAndGroup`'s `if (!match) return
  { unit: null, group: title }` and stays null even when `inferUnitFromCode` would have caught it;
  the two heuristics are never tried on the same title.

Downstream, a hand-typed unit already has a code path into storage: `ImportScreen.buildCommitInputs`
(~409–413) reads `preview.groupUnits[name]` (the file-inferred unit) into `links.groups`, which
`foldApprovedToRecords` (`src/ingest/fieldUpdate.js` ~32–71) folds into `record.fields.unit`,
which `buildPlan`'s `emitCreate`/`emitRecognized` diff/write like any other field (`groups`'
`COMPARABLE_COLUMNS` already includes `tier_id`; `SNAPSHOT_KEY.unit = 'unit_name'`), and
`resolveFieldWrite('unit', ...)` (`fieldUpdate.js` ~134–138) resolves it to `tier_id` at commit. **But
there is no UI to type a unit that isn't in the file**, and every write this path produces — whether
the value came from the file or from a director's future keystroke — is stamped `source: 'import'`
unconditionally, because `commitPlan`'s `IMPORT_SOURCE` constant (`ingest.js` ~382) is threaded into
every `appendOp` `commitCreate` and `commitUpdate` make (~617, ~647) with no per-field override. S2b's
Policy A gate (`decideFieldItem`, ~699–736) already protects any field whose `latestOp.source` is
`'human'`/`NULL` from a re-import's differing value — but nothing today can ever make a unit's
`latestOp.source` be `'human'`, so a director's future hand-pick would be silently overwritten by the
next re-import exactly like the pre-S2b bug S2b exists to prevent.

---

## Decision 1 — Fixed events route to the schedule only; dual-use is a reviewable exception

### Candidate approaches considered

- **A. Exclude every ticked-fixed-event name from the catalog, unconditionally.** *Rejected* — a name
  can legitimately be both: e.g. "Ceramics" is pinned for one unit's schedule slot but also offered as
  a free-choice elective at other periods. Blanket exclusion silently deletes a real catalog activity a
  director needs, which is the same "director loses something and doesn't notice" failure the whole
  ingest feature is built to avoid (2026-08-01 ADR §1).
- **B. Ask the director, per name, every time (a new conflict/resolution type).** *Rejected* — this
  reuses none of the existing tick machinery, adds a new held-conflict reason and a new UI surface for
  what is, in the overwhelming case (pin-only), not actually ambiguous. Disproportionate to the
  problem.
- **C1 (original, now REJECTED after Red Hat review). Compute a dual-use signal in `buildPlan` and
  silently drop pin-only names from the catalog with no renderer signal.** `fixedEvents.js` documents
  its own bias at ~9–11: *"Over-inclusion is the deliberate bias."* A small camp that happens to run,
  say, "Ceramics" at the same block every single day gets it classified high-confidence FIXED — not
  dual-use, because there is no "outside" `occupied` tuple to prove otherwise — and C1 would drop it
  from the activities catalog entirely, with `ImportScreen` still showing it ticked in the activities
  list (the UI was never told). That is a false positive in the fixed-event inference silently deleting
  a real catalog activity, invisibly — precisely the Candidate-A failure this ADR itself rejects two
  lines above, just relocated from "always drop" to "drop when the (necessarily imperfect) inference
  says fixed." Rejected: correct-but-unreviewable is exactly what the ledger review step
  (`ReconciliationLedger.jsx`, S5b) exists to prevent — a routing decision this consequential cannot be
  made invisibly inside the pure decision layer.
- **C2 (Selected). The inference SEEDS a default; the reviewed, ticked state in ImportScreen is what
  `buildPlan` actually routes on.** Every activity-like name that inference proposes routing away from
  the catalog is still shown to the director as an ordinary reviewable row, defaulted per its class, and
  one click away from being kept — exactly the same "everything shown, unticking is the deliberate act"
  discipline the rest of ingest already uses for low-confidence entities (`preview.js` `lowConfidence`).
  `buildPlan` never infers routing itself; it only ever executes the resolved decision the renderer
  sends. This keeps `buildPlan` pure (no new inference logic inside the decision layer) while making the
  routing visible and reversible, which is what actually fixes Risks 2/3 — the fix is not "have better
  inference," it's "never let inference alone make an invisible decision."

### The dual-use signal (a default, not a verdict)

`inferFixedEvents` (`src/ingest/fixedEvents.js`) already builds, per page, a raw tuple map `occupied:
Map<keyOf(group, block, activity), Set<day>>` (~54, ~62–66) **before** the majority filter that turns
some of those tuples into confirmed fixed events (~110–127, dropped when `occ * 2 <= operating`). That
pre-filter map is exactly the evidence needed: a `(group, block, activity)` tuple that exists in
`occupied` but was **dropped** by the majority filter is an occasion where the group did that activity
at that period on **fewer than half** its operating days — a free/rotating choice, not a pin. A name is
**dual-use** iff, after computing its confirmed fixed-event set, the SAME normalized name also has at
least one `occupied` tuple that is **not** covered by any of its own confirmed fixed events' `(group,
time_block)` footprint (a confirmed event's footprint is its `scope.groups` — or all groups, if
`is_all_groups` — crossed with its single `time_block`).

**Normalizer, end to end (Red Hat Risk 5).** Every group-identity comparison in this computation — the
`occupied`/`operatingDays` map keys, the footprint match against `scope.groups`, and the collapse-by-
activity in `inferFixedEvents` itself — MUST key on the single shared `normalizeName` from
`src/ingest/preview.js`, not the divergent local `norm()` closure `fixedEvents.js` currently defines at
~132–133 for its `is_all_groups` comparison only. Today that local `norm()` is used in exactly one place
(the `isAll` check, ~138–141) and nowhere else — every other group-identity key in the file (`occupied`,
`operatingDays`, the `collapsed` map's `entry.groups`) uses the RAW group name as its map key with no
normalization at all. Concretely:

- **Orientation A** (groups-are-pages, `orientation.columns === 'days'`): `groupName` comes from
  `groupNameByTitle[cleanTitle(page.title)]` (~71), which is already a resolved, canonical group name —
  safe as a key today, but should still be wrapped in `normalizeName` for consistency with orientation B
  below, so the SAME function guards both.
- **Orientation B** (groups-are-columns, `orientation.columns !== 'days'`): `groupName` is the RAW
  `page.columns` value taken directly off each day-page (~92, ~96), never normalized. Two day-pages
  spelling the same group with different whitespace or casing ("Zahav " on Monday's page, "zahav" on
  Tuesday's) fragment into two DIFFERENT keys in `occupied`/`operatingDays` today — which doesn't just
  risk the dual-use footprint check specifically, it can also fragment a genuinely-fixed event's
  `operatingDays` denominator, silently lowering its confidence or its majority.

**Fix: replace every raw group-name map key in `occupied`, `operatingDays`, and the `collapsed`
scope-building with `normalizeName(groupName)`**, and replace the local `norm()` closure with an import
of the shared `normalizeName` (deleting the local definition — one function, one place, matching every
other module in this pipeline). The value stored against a normalized key should be the FIRST spelling
seen (mirroring `extractEntities.dedupe`'s tie-break), so `scope.groups` in the final `fixedEvents[]`
output still reads with a real, camp-legible spelling, not a normalized/lowercased one.

Add this to `inferFixedEvents`'s return: `{ fixedEvents, dualUseNames: string[] }`, where
`dualUseNames` holds the exact display spelling of every name meeting the dual-use test above (dedup on
`normalizeName`, keep the most-frequent spelling — mirror `extractEntities.tally`'s tie-break so the
two proposals can never disagree about which spelling is canonical). This is pure, computed once,
alongside the existing collapse loop, from data the function already builds — no new pass over the
pages. **`dualUseNames` (and, symmetrically, the pin-only names — every ticked fixed event's name not
in `dualUseNames`) are DEFAULTS for the review UI below, never a routing verdict `buildPlan` consumes
directly** — that is the fix to Risks 2/3.

### The review surface — routing must be visible and reversible before commit

Per the coordinator's decision: every activity-like name inference wants to route away from the catalog
is shown to the director as an ordinary row in the existing activities review list (the same list
`preview.perEntity.activities.create` already renders), in one of two states, both driven by the SAME
`dualUseNames` computation above used only as a *seed*:

- **Pin-only** (a ticked fixed-event name NOT in `dualUseNames`): the activities-list row for this name
  starts **unticked** (excluded from `chosen.activities`, matching today's `lowConfidence` unticked
  treatment — reusing the SAME mechanism, not inventing a second one), with a note: *"Scheduled as a
  fixed event — not added to the activity catalog."* Ticking the row is the one-click override: if the
  director ticks it, it is no longer excluded — this is exactly what rescues an over-inclusive
  fixed-event false positive (the every-day "Ceramics" case Red Hat raised), because the director sees
  it, sees why it was excluded, and can reverse it with the tool they already use for every other row.
- **Dual-use** (a ticked fixed-event name that IS in `dualUseNames`): the row starts **ticked** (today's
  default, unchanged), with a note: *"Also appears as a fixed event."* No behavior changes for this
  class; only the note is new.

This reuses `chosen.activities` — the existing `Set` `ImportScreen` already builds per entity — and adds
no new tick state, no new conflict reason, no new held-review surface. A pin-only name's default
exclusion is now visible (the note) and reversible (the existing checkbox) before the commit is ever
staged to the ledger, which is what makes "correct but unreviewable" not apply here: nothing is decided
without the director seeing it in the SAME list they review everything else in.

### buildPlan's input: the RESOLVED routing, not raw inference

`buildPlan` stays pure and infers nothing about fixed-event/catalog overlap itself. It receives the
director's reviewed decision as an ordinary consequence of what's already in `approved.activities` (i.e.
`chosen.activities` at commit time) — **no new `source` key is needed for the common case**, because a
pin-only name the director left unticked is simply absent from `approved.activities` the same way any
other unticked name already is, and a dual-use or director-overridden name that IS ticked flows through
`buildPlan`'s existing entity loop completely unchanged. The only new input `buildPlan` needs is a
narrow one: which of the *ticked* `fixedEvents` names should **also** still route to the fixed-event
anchor path — which is unconditional and already true for every ticked fixed event regardless of catalog
routing (the anchor loop, ~827–896, is untouched by this decision entirely). **Net: this decision adds
NO new field to `buildPlan`'s `source` contract.** The routing "fix" lives entirely in `ImportScreen`'s
seeding of `chosen.activities`'s initial state (pin-only defaults unticked; dual-use defaults ticked,
mirroring the `lowConfidence` precedent at `preview.js`) and in the note rendered beside each affected
row — `buildPlan` and `commitPlan` require zero changes for Decision 1 beyond what a normal tick/untick
already produces today. This is a smaller, safer change than the original C1 design: it touches only
`fixedEvents.js` (the normalizer fix + `dualUseNames`) and `ImportScreen.jsx` (seeding + note), and
leaves the pure decision layer's contract exactly as it was before this ADR.

### Scope of matching — why this can't wrongly drop an unrelated activity, and the single-cohort assumption

`normalizeName` (shared from `src/ingest/preview.js`, now used end-to-end per the fix above) is the
matching key on both sides, matching the name-identity invariant `fixedEvents.js`'s own header
documents. **Activities are camp-scoped;** the routing decision above is derived fresh, per import, from
that import's own `fixedEvents`/`dualUseNames` — nothing about a PAST import's pin-only decision is
persisted or consulted. A later import (a different cohort's file, imported separately) that proposes
the same name genuinely dual-use is compared against the **live** `activities` table via
`buildPreview`/`buildExistingSnapshot`, exactly as every other name is: if the earlier pin-only import's
row was left unticked and created no catalog row, the later import sees no existing row and proposes a
fresh create — correct, no stale exclusion carries over.

**Explicit assumption (Red Hat Risk 6):** this reasoning depends on **one `ingestCommit` == one file (or
file set) == one cohort's `fixedEvents`/`dualUseNames` list**, which is true of every path through
`ImportScreen` today — `readFiles` parses one file set into one `proposal`/`inferFixedEvents` call scoped
to `activeCohort` (~99–101, ~263), and the S4b workbook re-import path is likewise single-cohort
(`workbookToSource`'s `cohort_id` parameter). If a future caller ever batches multiple cohorts' schedules
into a single `buildPlan` call, this section's no-collision claim must be re-verified: `dualUseNames`
computed across a mixed multi-cohort parse could conflate an activity that's genuinely dual-use in one
cohort with a same-named, purely-pinned activity in another, and the "derived fresh per import" argument
above assumes there is exactly one coherent `fixedEvents` proposal per commit, not a merge of several.
Flagged here so a future engineer touching multi-cohort import doesn't have to rediscover this.

### Interplay with T72 and the golden-ops snapshot

T72 (`electron/ops/ingest.t72.test.js`, ADR `2026-08-08-t72-fixed-event-reimport-idempotency.md`)
recognizes-then-skips an `anchor_activities` row already at its `(cohort_id, day_id, time_block_id,
normalizeName(name))` slot key. This ADR does not touch that loop, that key, or `buildPlan`/`commitPlan`
at all — the resolved design routes entirely through `ImportScreen`'s existing `chosen.activities` tick
set (see above), so `buildPlan`'s entity loop and `commitPlan`'s `commitCreate` are byte-identical to
today for any given `approved` input. T72's idempotency guarantee is unaffected.

**The golden-ops characterization test (`electron/ops/ingest.golden.test.js`) needs NO regeneration for
Decision 1.** Because the routing fix lives entirely in `ImportScreen`'s tick-seeding (which `approved`
names get sent) and not in `buildPlan`/`commitPlan` (which decide what to do with whatever `approved`
they're handed), the golden test — which drives `commitIngest`/`commitPlan` directly with an already-
built `approved` set, bypassing `ImportScreen` entirely — sees no behavior change at all. This is a
direct consequence of the C2 design choice: it was deliberately chosen partly BECAUSE it keeps the pure
commit layer untouched, which is a smaller and safer footprint than the original (rejected) C1 design
that would have required a golden-ops regen. If a later fixture is added that exercises `ImportScreen`'s
tick-seeding directly (a component/integration test, not the golden op-sequence test), that is new
coverage, not a regenerated snapshot.

### Which existing tests are affected, and how

`src/ingest/daysheet.test.js` ~79–87 asserts `entities.activities` (i.e. `extractEntities`'s own
output, not `buildPlan`'s) contains `'Closing Circle'`, `'Pick Up'`, `'Sign In'`. **These assertions are
correct and unaffected by this ADR** — `extractEntities` is deliberately unchanged: it must keep
proposing every activity-like name, pinned or not, because that proposal list is what feeds BOTH the
catalog preview and (via `activityPages`) the fixed-event inference itself. The bug this ADR fixes lives
one layer downstream, in `buildPlan`'s routing of an *approved* name into a catalog `activities` create
— a layer `daysheet.test.js` does not exercise. The prompt's flag that this file "pins the wrong
behavior" is not borne out by reading it: leave it as-is. The missing coverage is a **new** test at the
correct layer:

- A new unit test on `inferFixedEvents` in `src/ingest/fixedEvents.test.js` (or wherever its existing
  tests live) asserting the `dualUseNames` computation directly: a name occupying the same
  `(group, block)` on every operating day → confirmed fixed event, not dual-use; the same name ALSO
  appearing at a DIFFERENT block/group below majority → both a confirmed fixed event AND present in
  `dualUseNames`.
- **Risk 5's normalizer test (required, not optional):** an orientation-B fixture (groups-are-columns,
  one page per day) whose column header for the SAME group is spelled inconsistently across day-pages —
  e.g. `"Zahav\t"` (trailing tab) on Monday's page vs `"zahav"` (different case, no tab) on Tuesday's —
  asserting `inferFixedEvents` still recognizes them as one group: the activity's `operatingDays`
  denominator counts both days for the one normalized group, its majority/confidence is computed
  correctly (not silently halved by the fragmentation), and the dual-use footprint check correctly
  matches an "outside" occupied tuple against the SAME normalized group even when its raw spelling
  differs from the one recorded in the confirmed fixed event's `scope.groups`.
- An `ImportScreen`-level test (component or integration) asserting the review-seeding behavior directly:
  a pin-only name's activities-list row starts unticked with the "scheduled as a fixed event" note, and
  ticking it includes the name in `approved.activities` at commit — proving the one-click override
  actually reaches `buildPlan`'s input; a dual-use name's row starts ticked with the "also appears as a
  fixed event" note and behaves exactly as an ordinary ticked activity today.
- No `buildPlan`/`commitPlan`/golden-ops test changes are needed for Decision 1 (see above) — the
  absence of a change there is itself worth a one-line regression guard: an existing golden-ops fixture
  run with a `fixedEvents`/`activities` name overlap should be asserted to produce the SAME op sequence
  before and after this ADR's `fixedEvents.js`/`ImportScreen.jsx` changes land, proving the commit layer
  really is untouched.

---

## Decision 2 — Better unit inference, an editable review column, and provenance that survives re-import

### Candidate approaches considered

- **A. Parser-only fix; leave unit assignment file-driven with no UI.** *Rejected* — the owner's
  decision explicitly requires an editable column, because the file cannot always encode the unit
  (unlabeled per-day columns with no code, e.g.) and hand-assignment must be possible.
- **B. Editable unit column, but every re-import freely overwrites it (no provenance).** *Rejected* —
  this is the exact "F6" trust-killer S2b's Policy A was built to close for every other field; leaving
  units out of that protection while every comparable field (priority, eligibility, availability) has
  it would be an inconsistent, surprising exception a future engineer would have to relearn why it's
  there.
- **C. Reuse the S2b/Policy A provenance mechanism for `unit`, closing the one gap that keeps it from
  working today (create/update writes always stamped `'import'`, with no way for a director's review-
  time pick to be tagged `'human'`) — "Selected."** No new conflict type, no schema change (the
  `source` column and the Policy A gate already exist and already read `unit`'s comparable column
  correctly); the only new code is a narrow side-channel that lets `ImportScreen` mark specific fields
  on specific items as director-authored, and lets `commitCreate`/`commitUpdate` honor that mark when
  choosing which `source` value to write.

### Parser fixes (`src/ingest/extractEntities.js`)

**Groups-are-columns orientation (~267–269), currently hardcoded `unit: null`.** The column headers on
this layout are the raw group/bunk names — the same shape `inferUnitFromCode` and `splitUnitAndGroup`
already parse for page titles on the other orientation. Reuse both, don't invent a third heuristic:

```js
groups.push(...page.columns.map((c) => {
  const { unit, group } = splitUnitAndGroup(c)
  return { title: c, unit: unit ?? inferUnitFromCode(c), group }
}))
```

Both heuristics are already tightly anchored against false positives (`splitUnitAndGroup` requires a
whitespace-adjacent separator, unit length ≥ 2, and at least one letter; `inferUnitFromCode` requires
the WHOLE string to match `^([A-Za-z]|\d+)\s*[A-Za-z0-9]{1,2}(\s*\([^)]*\))?$`, so a plain word like
"Zahav" or "Gesher" already returns `null` from both). Reusing them inherits that safety bar rather than
loosening it — a header that is genuinely just a bunk name stays `unit: null`, as today. **Confidence:
medium-high** that this is safe without a labeling gate, because the regexes (not a heuristic threshold)
are what's doing the false-positive rejection; recommend the new test fixtures include at least one
groups-orientation camp whose headers are plain names (no code, no separator) to prove no false
positive appears before this ships.

**Groups-are-pages orientation (~261–263), title heuristic misses when neither shape matches.** Try
`inferUnitFromCode` as a fallback whenever `splitUnitAndGroup` finds no unit, on BOTH the labeled and
unlabeled branches (today `inferUnitFromCode` only ever runs on unlabeled pages):

```js
const primary = page.timeColumnLabeled === false
  ? { unit: inferUnitFromCode(title), group: title }
  : splitUnitAndGroup(title)
const unit = primary.unit ?? (page.timeColumnLabeled === false ? null : inferUnitFromCode(title))
const group = primary.group
groups.push({ title, unit, group })
```

This purely ADDS a second, already-vetted heuristic as a fallback — it never overrides a unit either
heuristic already found, and a title matching neither shape stays `null`, per "a wrong unit is worse
than a blank one." Do not go further than this (e.g. fuzzy separators, colon/slash support) without a
real customer fixture motivating it — that is new heuristic surface, not a fallback of proven logic, and
belongs in a follow-up if and when a camp's file actually needs it.

### The reviewable unit column (ImportScreen)

Add a per-group unit control to the groups review rows (wherever `preview.perEntity.groups.create`
renders today): a `<select>` whose options are the union of (a) tiers the file already proposed
(`preview.entities.tiers.create`), (b) tiers the camp already has (`existingRecordsAll.tiers`, filtered
to the active Program the same way duplicate-detection already scopes tiers, ~235–236), (c) a
"+ New unit…" option that reveals a text input for a name not in either list, and (d) a "No unit"
option that explicitly clears it. State: `const [groupUnitOverrides, setGroupUnitOverrides] =
useState({})` — `{ [groupName]: unitName | { clear: true } }`.

**Three distinct review states (Red Hat Risk 1 — the original snippet collapsed two of these into one
falsy check and silently dropped an explicit clear):**

1. **Unset — leave to inference.** `groupUnitOverrides[name]` is absent. The file's inferred unit (if
   any) flows through exactly as today, via `preview.groupUnits[name]` into `links.groups` →
   `record.fields.unit`.
2. **Set to a unit.** `groupUnitOverrides[name]` is a non-empty string — the director picked or typed a
   unit. Flows into `links.groups`/`record.fields.unit` exactly as case 1, but ALSO marked in
   `source.humanEditedFields` (below) since the director authored it.
3. **Explicitly cleared.** `groupUnitOverrides[name]` is `{ clear: true }` — the director picked "No
   unit" to remove a unit the file proposed (or that the group already has, on a re-import). This must
   NOT flow through `links.groups`/`fields.unit` at all — a clear is not a value, it is the tri-state
   `CLEAR` sentinel `buildPlan.js` already defines (`CLEAR = Symbol('clear')`, ~22) and the S4b clear
   path already wires end-to-end (`record.clears`, folded at `buildPlan.js` ~187–236, resolved through
   `resolveFieldWrite`'s clear branch in `commitPlan`'s `decideFieldItem`, ~700–725). Route it there
   instead: the record `buildCommitInputs` builds for this group gets `record.clears: ['unit']` (not
   `record.fields.unit`), so `buildPlan` emits `op:'clear'` with `fields.unit = { from: <live>, to: CLEAR,
   source: 'import' }` exactly as any other S4b clear does.

```js
for (const name of approved.groups ?? []) {
  const override = groupUnitOverrides[name]
  if (override && typeof override === 'object' && override.clear) {
    clears[name] = ['unit']       // routes to record.clears, NOT groupUnits/links.groups
    humanFields[name] = ['unit']  // the clear is director-authored too — see below
  } else if (override) {
    groupUnits[name] = override
    humanFields[name] = ['unit']
  } else if (preview.groupUnits?.[name]) {
    groupUnits[name] = preview.groupUnits[name]   // unchanged: file-inferred, no override
  }
}
```

(`clears`/`humanFields` here are new per-group maps threaded into `buildCommitInputs`'s returned
`inputs` — e.g. `inputs.clears = { groups: clears }`, folded into each group's `record.clears` alongside
the existing `links.groups` fold, and `inputs.source.humanEditedFields = { groups: humanFields }`, per
the provenance mechanism below.)

**The cleared write must ALSO carry human provenance (Red Hat Risk 1, second half).** A clear is the
most destructive delta a director can make to this field, and if the resulting write were stamped
`source: 'import'`, a LATER re-import proposing the file's original (now-stale) unit would see no
protected prior op and silently re-populate the field the director just removed — reintroducing exactly
the bug this whole decision exists to close, just via the clear path instead of the set path. So the
clear write is included in `humanFields[name]`/`item._humanFields` (§ below) on equal footing with a
set: `commitCreate`/`commitUpdate` stamp `source: 'human'` on the null-write a clear produces, exactly
as they would on a set value.

A typed unit name (case 2) that matches no existing/proposed tier is unioned into `approved.tiers` at
commit time (the same tick-set `chosen.tiers` already holds, or a synthetic addition alongside it) so
`buildPlan`'s existing `tiers` create path (`fieldsFor('tiers', ...)`) mints it — no new create
mechanism, this is the identical path a file-inferred new unit already takes today.

### Provenance across re-import — the seam that was actually missing

The diff/write path for `unit` already exists end-to-end and needs **no new code** to compare and
protect a value once it's tagged correctly: `COMPARABLE_COLUMNS.groups` already includes `tier_id`,
`SNAPSHOT_KEY.unit = 'unit_name'` already resolves the FK to a comparable label, `resolveFieldWrite`
already resolves a proposed unit name to `tier_id` at commit, and `decideFieldItem`'s Policy A gate
(`ingest.js` ~699–736) already refuses to overwrite a field whose `latestOp.source` is `'human'`/`NULL`,
converting a differing re-import proposal into a `stale` conflict instead. **The one missing piece is
provenance at the moment of writing:** `commitCreate` and `commitUpdate` stamp every field-value op with
the single module-level `IMPORT_SOURCE` constant, with no way to say "this one field, on this one item,
was the director's pick, not the file's."

**The fix: an item-level side-channel naming which fields on this specific item are director-authored,**
mirroring how `_link_unit`/`_rule` already ride on plan items as commit-resolution inputs `buildPlan`
cannot resolve itself (`buildPlan.js` ~298–313):

1. `ImportScreen.buildCommitInputs` records, per group name whose unit came from `groupUnitOverrides`
   (i.e. the director explicitly picked or typed it — NOT the file-inferred default flowing through
   unchanged), a new commit input: `source.humanEditedFields: { groups: { [groupName]: ['unit'] } } }`.
   Only entries the director actually touched go in this map — a group whose unit is still the file's
   inference is absent, and its write stays `source: 'import'` exactly as today.
2. `buildPlan`'s `emitCreate` and `emitRecognized` (both already build `item` objects per name) attach
   `item._humanFields = source.humanEditedFields?.[entity]?.[name] ?? []` — a plain array of field
   names, computed once per item, no change to the `FieldDelta` shape itself (`fields[field]` stays
   `{ from, to, source: 'import' }` exactly as every other field — `_humanFields` is metadata about
   which delta to re-stamp at write time, not a new delta shape).
3. `commitCreate` and `commitUpdate` (`ingest.js` ~560–650), in their existing per-field `appendOp`
   loops, choose the `source` to write per field instead of the blanket `IMPORT_SOURCE`:
   `field in (item._humanFields ?? []) ? 'human' : IMPORT_SOURCE`. Every other field on the same item —
   including `unit` on an item the director did NOT touch — is unaffected. **Field-name mapping detail:**
   `item._humanFields` is populated from `humanEditedFields`, which speaks the SOURCE field name
   (`'unit'`), but `commitUpdate`'s write loop (and `decideFieldItem`'s `toUpdate` entries) operate on
   the STORED/db column (`dbFieldFor('unit') === 'tier_id'`, `fieldUpdate.js` ~20–21). The `_humanFields`
   check at write time must compare against the SAME `dbFieldFor`-mapped name `decideFieldItem` already
   computes (`const dbField = dbFieldFor(field)`, `ingest.js` ~703), not the raw record field name — i.e.
   `item._humanFields` should be normalized to stored-column names once, at the point `buildPlan` attaches
   it, so every downstream comparison (both the clear path and the set path) uses one consistent name.
   This applies identically to the clear write from Risk 1: `decideFieldItem`'s clear branch
   (`isClear && !latest`/`enqueue`, ~707–725) pushes `{ item, field: dbField, value: null, parent_op_id }`
   onto the SAME `toUpdate` list a set does, so `commitUpdate` needs no separate branch for "cleared
   human field" versus "set human field" — one check, `dbField in item._humanFields`, covers both.

**Trust boundary (Red Hat Risk 4).** `_humanFields`/`humanEditedFields` and the review-tick routing from
Decision 1 cross **no new trust boundary**. They arrive at `commitPlan` only via the same host-trusted
`shoresh:ingest-commit` IPC handler every other ingest input already uses
(`electron/main.js:1115` → `handlers.ingestCommit`, ~239), alongside `approved`/`links`/`activityRules` —
all renderer-authored, all already trusted at exactly this boundary today. This is NOT the S2a
forgeable-`source` threat (`'import'` producible only by host-local `commitPlan`, never by a submitted
op over the WS `submit_op` path) — that threat model concerns a REMOTE peer forging provenance over the
network sync protocol, which is untouched here. `_humanFields` only ever causes `commitPlan` to write
`source: 'human'` INSTEAD OF `source: 'import'` on a field the renderer already had full authority to
set the VALUE of through this same IPC call; it grants no new write capability and reaches no code path
outside the existing host-local ingest commit.

This is deliberately **not** a reshape of the `FieldDelta`/record contract (rejected during design: a
`{value, source}` wrapper on every `fields.unit` would ripple through `foldApprovedToRecords`, every
`buildPlan` diff branch, and `fieldUpdate.js`, for a distinction only ONE caller — `ImportScreen`'s new
UI — currently needs). It is the smallest change that lets one specific caller mark specific fields on
specific items as human-authored, using the exact same "item carries commit-resolution metadata
`buildPlan` cannot itself resolve" pattern the codebase already established for `_link_unit`/`_rule`.

**Why this must also apply on CREATE, not only UPDATE.** Policy A's protection only visibly fires on a
SECOND import (there is no prior op to protect on the very first write). But if the FIRST write —
minting a brand-new group with a director-picked unit — were stamped `'import'` regardless of who chose
it, the group would have no prior `'human'` op for a LATER re-import's gate to find, and that later
import's differing file-inferred unit would freely overwrite the director's original hand-pick with
`op:'update'`, silently — exactly the bug this decision exists to prevent, just deferred one import
later. `commitCreate` honoring `_humanFields` from the first write is therefore load-bearing, not
cosmetic.

**Scope note.** This mechanism is generic (`_humanFields` is a field-name array, not a unit-specific
flag) but this ADR wires it for `unit` only, per the locked decision. `ImportScreen`'s
`updateActivityRule` already lets a director hand-edit `min_per_week`/`max_per_week`/`priority`/
`eligible_group_names` during review (`_inferred: false`, ~369–373) and those writes go through the
SAME unconditional `IMPORT_SOURCE` stamp today — meaning a director's hand-tuned activity rule can
already be silently overwritten by a later re-import, the identical bug class, just not in scope here.
**Flagged as a follow-up, not fixed by this ADR** — wiring `_humanFields` for those fields too is a
natural extension of the exact same mechanism once this lands, and worth its own small ticket rather
than growing this one.

### Tests/fixtures to add or change

- `src/ingest/extractEntities.js` unit tests (new cases in `daysheet.test.js` or a new
  `extractEntities.units.test.js`): groups-are-columns fixture with code-shaped headers ("KA", "1A")
  now populates `groupUnits`; a parallel fixture with plain-name headers ("Zahav", "Gesher") still
  yields `unit: null` for every group (no false positive); groups-are-pages fixture with a title
  matching neither `splitUnitAndGroup` nor the old unlabeled-only `inferUnitFromCode` gate (e.g. a
  labeled page titled just "2A" with no `-` separator) now infers a unit via the new fallback.
- A new `electron/ops/ingest.unit-provenance.test.js` (mirroring S2b's own F6/R1 evidence tests):
  (1) a group created with `_humanFields: ['tier_id']` (director-picked unit) writes its `tier_id` op
  with `source = 'human'`; (2) re-importing that same group with a DIFFERENT file-inferred unit produces
  `op:'conflict', reason:'stale'` on `unit`, the whole import held, nothing written — asserted the same
  way S2b's F6 test asserts it for other fields; (3) a control case: a group whose unit came from the
  file (no `_humanFields`) writes `source = 'import'`, and a later re-import with a changed file value
  updates it freely, no conflict — proving the gate still discriminates correctly and this ADR hasn't
  turned every unit write into friction.
- **Risk 1's explicit-clear test (required, net-new).** (a) A group with an existing unit, re-imported
  with `groupUnitOverrides[name] = { clear: true }`: asserts `op:'clear'` on `unit` (not silently
  dropped, not folded into `groupUnits`), the `tier_id` write is `null`, AND the write's `source` is
  `'human'` (not `'import'`) — proving the clear both took effect and is protected. (b) A THIRD import,
  after (a), proposing the file's original unit again: asserts a `stale` conflict (the clear is
  protected exactly like a set value would be), NOT a silent re-population of the cleared unit — this is
  the specific regression the broken `if (unit)` snippet would have produced, and must be asserted
  directly, not just implied by (a). (c) A control: `groupUnitOverrides[name]` absent (case 1, unset) on
  a group whose file-inferred unit differs from last import — updates freely, `source: 'import'`, no
  conflict, confirming the fold from `preview.groupUnits[name]` is unaffected by the new clear path.
- `ImportScreen` — a component-level or integration test asserting: the unit `<select>`'s three states
  (unset / set / "No unit") reach `groupUnitOverrides` correctly, and `buildCommitInputs()`'s output
  routes each state correctly — set → `links.groups` + `source.humanEditedFields`; cleared →
  `record.clears: ['unit']` + `source.humanEditedFields` (NOT `links.groups`); unset → `links.groups`
  from `preview.groupUnits` only, no `humanEditedFields` entry. No existing test currently exercises this
  path (there is no unit-editing UI today), so this is net-new coverage, not a changed assertion.

---

## Build order

**Fixed-event routing first (Decision 1), then units (Decision 2).** Decision 1 is smaller, touches only
`fixedEvents.js` and `ImportScreen.jsx`, and leaves `buildPlan`/`commitPlan` untouched (no golden-ops
regen needed) — it can land and ship independently, verified by the `fixedEvents.js` unit tests, the
Risk 5 normalizer fixture, and the new `ImportScreen`-level test. Decision 2 has three separable parts
in this order: (a) the parser fixes, which are self-contained and testable against fixtures alone; (b)
the review-column UI, which depends on nothing from (a) landing first but is more useful once units
infer better; (c) the provenance side-channel, which is the highest-risk piece (it is the part most
likely to be quietly wrong, per the brief) and should land last, with its own dedicated test file, once
(a) and (b) give it real inputs to protect.

---

## Consequences

- A pinned fixed-event name defaults to NOT double-writing a free-choice catalog activity, but the
  default is always visible (a note on its review row) and always one click from reversed — no name
  ever silently disappears, and an over-inclusive fixed-event false positive is rescuable by the
  director before commit, not baked into a pure-inference decision nobody sees.
  A genuinely dual-use name still defaults to kept-in-catalog, visibly noted, exactly as before.
- Decision 1 requires **no change to `buildPlan`'s `source` contract at all** — the fix lives entirely
  in `fixedEvents.js` (the normalizer correction + `dualUseNames`) and `ImportScreen.jsx` (tick-seeding +
  notes), which is a smaller footprint than originally designed and means the golden-ops characterization
  test needs no regeneration for Decision 1.
- Units infer correctly in more of the source file's shapes, using only the two heuristics already
  proven safe on labeled camps — no widening of either regex.
- A director can assign OR explicitly clear a unit the file cannot correctly encode, and both actions
  survive every future re-import exactly the way a hand-edited activity priority or eligibility list
  already does — using the existing Policy A and S4b clear machinery, not new ones.
- `buildPlan`'s `source` input contract grows one new optional key for Decision 2
  (`humanEditedFields`), plus the existing S4b `record.clears` path now has a real caller from a raw
  schedule source for the first time (previously only the enrichment-workbook path used it). Every
  existing caller that omits `humanEditedFields` gets exactly today's behavior, so this is additive and
  backward compatible, not a breaking change.
- `fixedEvents.js`'s group-identity keys are now consistently normalized end-to-end, which also fixes a
  latent (previously unflagged) confidence-computation bug on orientation-B camps with inconsistent
  column-header spelling across day-pages — a side benefit of closing Risk 5, not a scope increase.

---

## Open questions for the product owner / Governor

1. **Decision 1's defaults (pin-only unticked / dual-use ticked, both with a note and both one click
   reversible) — this is the coordinator's locked direction, not reopened here.** The only remaining
   judgment call is copy/placement of the two notes, filed as open question 4 below.
2. **Decision 2's parser loosening on groups-are-columns headers (medium-high confidence, not certain).**
   I could not verify against a real third-camp fixture whether every plain-name header in that
   orientation is safely rejected by the reused regexes — recommend the Maker add the plain-name-header
   fixture called out above and treat a single false positive there as a stop-ship signal for this
   specific change, not the whole ADR.
3. **The activityRules provenance gap (flagged, not in scope).** Confirm whether it should be filed as
   an immediate follow-up ticket now (same bug class, already live in production) or deferred — I have
   not sized it, only located it.
4. **UI copy/placement for the dual-use note and the new unit `<select>`** — Designer's call, not an
   architecture question; noted here only so it isn't dropped between this ADR and the Maker brief.
