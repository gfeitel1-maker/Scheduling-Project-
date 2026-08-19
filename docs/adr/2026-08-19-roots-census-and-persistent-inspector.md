---
title: "Roots census roster + persistent inspector (Slices 2/3/4)"
document_type: adr
status: proposed
authority: normative
implementation_state: not_started
date: 2026-08-19
task_class: ui-ux-design
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/standards/DESIGN_STANDARD.md, docs/governance/standards/ARCHITECTURE_STANDARD.md]
related_specs:
  - docs/work/specs/2026-08-19-roots-reconciliation-audit.md
  - docs/adr/2026-08-18-rootmap-screen-port.md
archive_when: Slices 2-4 ship and this is folded into PLATFORM_STATE
---

# Roots census roster + persistent inspector

**Invariant this ADR serves (unchanged from the audit, propagated to Maker):**
**One reconciliation system. One screen. Roots as the projection/navigation surface.
Quiet at first glance, deep on demand.**

This ADR ratifies Slices 2, 3, 4 of `docs/work/specs/2026-08-19-roots-reconciliation-audit.md`
§12, resolving the three HIGH findings Red Hat raised against the original §9 plan (audit §11) and
answering the seven design questions the audit's gate demands (a–g below). It does **not** relitigate
H1 (Slice 1, quiet default) or the port mechanics already decided in
`docs/adr/2026-08-18-rootmap-screen-port.md`.

**Revision note (Red Hat re-challenge, same date):** the architecture (file-less inspect path,
`template_overlays`/`PRESET_STAMPS`, `ReconstructionMoment` gating, `SCREENS` mount pattern) was
verified correct against the running code. Five code-verified contradictions were found and are
resolved in place below, each marked **[R1]–[R5]**: (R1) §(a)/(e) — the snapshot key scheme now
matches `CHILD_OF`'s table-name keys exactly, and (c)'s invariant gained a per-child attribution
check, not just a total; (R2) §(c)/worked example — the completeness invariant now separates live
rows from decision-attributed proposed-new rows, and the worked example's arithmetic is fixed to
match; (R3) §(d)/(g) — `not_set_up` is now scoped to the five `REQUIRED_AREAS` children only, with
an "optional — none yet" panel-copy distinction (no new token) for the three optional children and
for Context; (R4) §(b) — Activities' grouping claim is removed (no backing field exists); it is
flat-list-plus-search only, stated explicitly; (R5) §(a)/(b)/worked example — Groups' grouping now
uses the real `tier_id → tiers.name` join (labeled "Age Division," the actual codebase vocabulary
for that relationship), not a nonexistent Unit join, with an explicit "(no age division)" bucket for
`tier_id === null`.

## Candidate approaches considered

The high-leverage divergence question is: **where does the "374" live, and how does a director
reach one entity inside it without either a wall of facts or rebuilding Camp Setup inside Roots?**
Five genuinely different shapes were considered:

1. **Canvas grows with camp size** — one dot per entity, canvas re-lays-out as data grows.
   *Rejected* — this is the exact "wall of 374" Red Hat blocked (HIGH-1); `layoutForChild` also
   hard-caps at 5 positions, so it doesn't even render correctly past 5 children.
2. **Category node + roster-in-panel, roster is a flat scrollable list** — the minimal fix: click
   "Activities," see 30 rows, scroll to find one. *Viable but weak* — at 30+ rows a flat list with
   no search is the "wall" restated one level down, just behind a click.
3. **Category node + roster-in-panel, roster is searchable/filterable with grouping** ★ — same
   canvas discipline as #2, but the panel roster gets a search box and a natural grouping axis
   (e.g. Groups by their real Age Division grouping). This is the chosen approach — see below;
   which children actually get grouping, and by what field, is corrected in §(a)/(b)/(R4)/(R5) below
   against the real schema, not assumed here.
4. **Separate "browse all entities" screen, Roots links out to it** — decouples the census browser
   from the root-map metaphor entirely. *Rejected* — this recreates the "two systems" failure mode
   the audit's headline says did NOT ship; a second browsing surface competing with Roots violates
   the one-screen invariant even if it's reachable *from* Roots.
5. **Progressive disclosure — panel shows first 8 + "show 22 more"** — no search, just pagination.
   *Trap*: cheap to build, but a director who knows the name of the group they're looking for
   ("where's the Shoresh unit?") still has to page-hunt; search is barely more code and strictly
   better for the actual task (audit's own success criterion: "I can immediately see... I can
   explore").

**Converged on #3** (search + light grouping inside the existing panel), because it is the smallest
addition that satisfies the audit's own success criterion for the calm-374 case, reuses the panel
that already exists rather than adding a new surface, and costs one small stateful component
(`RosterList`) rather than a new screen or a new canvas layout algorithm.

For the inspect-mode data path (open questions e/f), two shapes were considered:

1. **Inspect mode reuses `ReconciliationScreen`'s `fetchReadiness`-shaped snapshot fetch, wrapped in
   a new top-level condition** ★ — chosen; see §(e).
2. **Inspect mode gets its own screen component entirely, duplicating the fetch/model-build
   wiring** — *rejected*, this is exactly the "quiet at first glance" surface Red Hat wants to avoid
   duplicating (two code paths that can drift on what "the census" means), and it fails karpathy:
   `ReconciliationScreen` already owns exactly this loading/error/model-build lifecycle for import
   mode; inspect mode is a narrower version of the same lifecycle, not a different one.

## Approach

### (a) Census roster data shape

`buildRootMapModel` gains a `mode` parameter and a live-entity input, and returns a `roster` array
per child alongside the existing canvas fields. The canvas-facing shape (`key, label, state, x, y,
children[]`) is **unchanged** — this is the load-bearing constraint from Red Hat HIGH-1/HIGH-2:
canvas node count and `rootMapLayout` are untouched by this ADR.

```js
buildRootMapModel(report, { answers, dismissedGaps, snapshot, mode }) -> {
  domains: [{
    key, label, state, x, y,       // unchanged — canvas fields
    children: [{
      key, name, count, state, x, y, decisionIds: string[],   // unchanged — canvas fields
      roster: [{                    // NEW — panel-only, never touches canvas
        entityId: string,
        name: string,
        state: 'understood' | 'attention' | 'changed' | 'not_set_up',
        decisionId: string | null,   // the one decision (if any) attributed to this entity
        group: string | null,        // grouping key for large-roster browsing, see (b)
      }]
    }]
  }]
}
```

**[R1] `snapshot` uses one canonical key scheme: the exact table names `CHILD_OF`/`DOMAIN_OF` are
already keyed by.** Verified against code: `fetchReadiness`'s `collections` object
(`ReconciliationScreen.jsx:31-40`) uses aliased keys — `days`, `timeBlocks`, `anchors` — that do
**not** match `CHILD_OF`'s table-name keys `days_of_operation`, `time_blocks`, `anchor_activities`
(`domainRollup.js:58-67`). Running the roster's `CHILD_OF`-reverse grouping directly over
`fetchReadiness`'s collections would silently misfile three of eight children into the `'General'`
fallback bucket — every `days` entry, every `timeBlocks` entry, every `anchors` entry would land in
`General` instead of `Days`/`Time Blocks`/`Fixed Events`, and the total-count invariant in (c) as
originally written would not catch it (nothing is dropped, only misbucketed).

**Resolution:** `snapshot` is a **new object shape, distinct from `fetchReadiness`'s `collections`**,
produced by `fetchCensusSnapshot()` (§(e)) and keyed **exactly** by table name:
`{ cohorts, tiers, groups, days_of_operation, time_blocks, locations, activities, anchor_activities }`
— the same eight strings `CHILD_OF` and `DOMAIN_OF` already use, so the reverse-grouping in
`rootMapModel.js` is a literal `Object.keys(snapshot).forEach(entityType => ...)` with no alias
table to keep in sync. `fetchReadiness`'s own `collections` object and its aliased keys are
**untouched** — `getReadiness`'s `COLLECTION_FOR` mapping (`readiness.js:88-95`) already handles
that translation for its own purpose and this ADR does not touch it. The two fetches issue
overlapping `localClient.list` calls in import mode (an accepted, minor duplication — see Open
Questions — not a correctness risk, since each produces its own independently-keyed object; they
are never merged).

`buildRootMapModel` receives `snapshot` in both modes: for `mode: 'import'`, Slice 2 adds a
`fetchCensusSnapshot()` call alongside (not instead of) `ReconciliationScreen`'s existing
`fetchReadiness()` call, so roster-building always reads the canonical-keyed object regardless of
mode. For `mode: 'inspect'`, `snapshot` is the only data source (§(e)) — there is no decision
overlay in that mode.

**Roster construction is per-child, driven by `CHILD_OF`'s existing entity→child mapping run in
reverse** — `rootMapModel.js` groups `snapshot`'s per-entity-type arrays into the same child buckets
`CHILD_OF` already defines (e.g. `cohorts` rows → `Units` roster, `activities` rows → `Activities`
roster), so a name change to `CHILD_OF` automatically re-buckets the roster too — one mapping, not
two, **now that the keys actually agree.**

Per-roster-entry `state`:
- `'changed'` / `'attention'` if a decision (`decisionId`) is attributed to that specific entity —
  attribution is by `decision.entityId` where available (most `confirm_value`/`confirm_change`
  decisions carry it already), else the entry has `decisionId: null` and inherits `'understood'`.
- `'understood'` — no decision attributed, entity exists in the live snapshot.
- `'not_set_up'` — see (d), **now scoped to the five `REQUIRED_AREAS` children only** (Age
  Divisions, Groups, Days, Time Blocks, Activities); assigned by the caller, not inferred by
  `stateOf`, when that child's entire backing table is empty in a non-fresh camp context.

Roster entries also include **proposed-new entities** in `mode: 'import'` — an entity a decision
proposes creating (e.g. a new group named in the source file) has no row in the live `snapshot` yet,
so it cannot come from the reverse-grouping pass above. `rootMapModel.js` appends one roster entry
per `confirm_value`/create-shaped decision whose entity does not already exist in `snapshot` (no
matching id), with `entityId: null` (no live id yet), `decisionId` set, `state: 'attention'` or
`'changed'` per the decision. This is the second, explicit input to roster construction that (c)'s
invariant must account for.

In `mode: 'inspect'`, every roster entry is `'understood'` or `'not_set_up'` (or the optional-empty
case, §(d)) — there is no decision overlay and no proposed-new entries, because inspect mode never
runs `buildReconciliationReport` (§(e)). `domains[].children[].decisionIds` is always `[]` in
inspect mode; the panel's existing "Show all decisions" affordance is suppressed when
`mode === 'inspect'` (nothing to show).

### Worked example (realistic camp: 40 groups, 30 activities, 12 locations)

Import mode, mid-reconciliation, after a file import that named 38 of 40 existing groups (2 new
groups proposed, 1 existing group's `min_age` changed) and all 30 activities cleanly. The live
`snapshot.groups` array has **40 rows** (all 40 pre-existing groups — nothing is removed by an
import, only proposed as changed or newly-created); the 2 proposed groups are decision-only and are
**not** in `snapshot.groups` yet (§(a)'s proposed-new appendage).

`group` (the roster's grouping label, **[R5]** fixed) is derived the same way
`fieldUpdate.js`'s `enrichSnapshotRow` already labels groups — `row.tier_id → tierNameById.get(...)`
(`fieldUpdate.js:101-103`). That relationship is a **tier**, which this codebase's own vocabulary
names **Age Division** (`CHILD_OF.tiers = 'Age Divisions'`, `domainRollup.js:60`) — not a Unit
(`CHILD_OF.cohorts = 'Units'`, a different, unrelated table with no join path from `groups` today).
The roster label is `"Age Division: {tierName}"`, and a group whose `tier_id` is `null` gets the
explicit bucket `"(no age division)"` rather than being silently omitted from every group header:

```js
{
  key: 'Structure', label: 'Structure', state: 'attention', x: 0.28, y: 0.46,
  children: [
    {
      key: 'Groups', name: 'Groups', count: 3, state: 'attention', x: 0.23, y: 0.72,
      decisionIds: ['d_grp_new_1', 'd_grp_new_2', 'd_grp_change_minage'],
      roster: [
        { entityId: 'g_shoresh', name: 'Shoresh', state: 'understood', decisionId: null, group: 'Age Division: Amitim' },
        // ...34 more understood entries, all live rows from snapshot.groups...
        { entityId: 'g_orphan', name: 'Wanderers', state: 'understood', decisionId: null, group: '(no age division)' /* tier_id is null */ },
        { entityId: 'g_bogrim', name: 'Bogrim', state: 'changed', decisionId: 'd_grp_change_minage', group: 'Age Division: Sollelim' },
        // ^ the above 40 entries are ALL live snapshot.groups rows (36 understood + 1 no-tier + 1 changed = 38 shown; 2 more omitted from this excerpt for brevity, still counted)
        { entityId: null, name: 'Ohel', state: 'attention', decisionId: 'd_grp_new_1', group: null /* proposed-new: no live row, no tier_id to join yet */ },
        { entityId: null, name: 'Teva', state: 'attention', decisionId: 'd_grp_new_2', group: null },
      ],
    },
  ],
}
```

`Groups` canvas node still shows `count: 3` (unchanged from today — the decision count). The roster
array carries **42 entries**: **40 live rows** (`snapshot.groups.length === 40`) **plus 2
proposed-new rows** sourced from decisions (`Ohel`, `Teva`) — this is exactly the split (c)'s revised
invariant checks, not a flat count against the live snapshot alone.

### (b) Large-category browsing (30+ quiet entities)

The panel's node-selection branch (`RootMapPanel.jsx`'s `selection.type === 'node'` case) renders a
new `RosterList` component **below** the existing "Open in {Screen} →" button and above/interleaved
with any decision cards, whenever `roster.length > ROSTER_INLINE_THRESHOLD` (constant, `8` — small
categories like `Locations` at 12 entries render as a plain list with no chrome; large ones like
`Activities` at 30+ get the full treatment below). Below threshold, `RosterList` renders the same
plain list, just without the search box — one component, one behavior, sized by content.

`RosterList` behavior at 30+ entries:
- A text input, placeholder `Find in {count}...` (e.g. "Find in 30..."), filters `roster` by
  case-insensitive substring match on `name`. No debounce needed — an in-memory filter over ≤a few
  hundred rows is instant; this is not a network search.
- Entries render as compact rows: name + a small state dot (reusing the existing four-state token
  colors from `RootMap`'s node states, not inventing a fifth palette) + `group` as trailing muted
  text if present (e.g. "Bogrim — Age Division: Sollelim").
- **Grouping is opportunistic and strictly limited to children with a real, semantically-correct
  backing field — never invented.** **[R4]** Verified against `electron/db/schema.sql:260-283`: the
  `activities` table has no category/tag/type column. Activities has **no grouping field today** —
  its roster is flat-list-plus-search only, stated here explicitly rather than implied as universal.
  The **only** child with real grouping in this ADR's scope is **Groups**, via the `tier_id →
  tiers.name` join (§(a)'s worked example, labeled "Age Division" — the real vocabulary, not
  "Unit"), including the explicit `"(no age division)"` bucket for `tier_id === null` so those rows
  are never silently left outside every header. `Locations` and every other child render as a flat
  alphabetized list, same as Activities — grouping is added per-child only when a real field
  justifies it, not as default scaffolding every roster is expected to populate. When grouping does
  apply, entries render under collapsed-by-default `<h4>` group headers matching the count each
  group carries, e.g. "Age Division: Amitim (8)" — this directly answers "where's the Shoresh unit"
  faster than scrolling 40 flat rows.
- Entities with `state !== 'understood'` (attention/changed/not_set_up) always render **above** the
  fold regardless of the search filter or group collapse state — a director should never have to
  search to find the one thing in a 30-row category that actually needs them; that's still the
  decision cards' job for anything with a `decisionId`, but a `not_set_up` roster entry has no
  decision card, so `RosterList` is its only surface (see (d)).
- No pagination, no virtualization at this scale (max realistic camp entity count per category is
  low hundreds — plain DOM list, matches the "374 total, not 374 canvas dots" framing; if a future
  camp genuinely needs virtualization that's a surfaced follow-up, not designed here).

This is a new, small, roster-only component — it does not touch `DecisionCard`/`RequiredGapCard`
(unchanged) and does not touch the canvas layer at all.

### (c) Census-completeness invariant

Add to `rootMapModel.test.js`, alongside the existing `Σ child.decisionIds === report.decisions.
length` assertion. **[R2]** Revised: the original single-equality form (`Σ roster.length === Σ
snapshot[type].length`) is provably false in import mode, per §(a)'s worked example — proposed-new
entities (Ohel, Teva) are real roster rows with no live-snapshot row to count against, so a flat
count-of-live-rows-only equality can never hold once any create-shaped decision exists. The
invariant is split into two parts instead of loosened into a vaguer one:

**Part 1 — live-row coverage (both modes), per-child attribution, not just a total.** **[R1]** A
total-count-only invariant would not have caught the snapshot-key misfile in (a) — three children's
worth of rows landing in `General` instead of their real child still sums to the same total. The
invariant therefore asserts **per entity type**, not just in aggregate:

```
for each entityType in Object.keys(snapshot):
  liveRosterCount(model, entityType) === snapshot[entityType].length
```
where `liveRosterCount(model, entityType)` sums roster entries across every domain/child whose
`entityId` traces back to a live row of that `entityType` (the model can report this because each
roster entry's construction pass knows which `snapshot[entityType]` array it came from — Maker
threads a `sourceType` through construction, dropped before the entry is returned to the panel, kept
only for the test to introspect via a test-only export or by re-deriving membership from `CHILD_OF`
applied to `entityType` and checking that exact child's roster). This catches a misfile (an
`entityType`'s rows landing in the wrong child, or in `General` when they have a real `CHILD_OF`
entry) even when the total is unaffected — the specific failure mode (a) found.

**Part 2 — total roster accounting, live + proposed-new (import mode only).**

```
Σ over all domains/children, of child.roster.length
  === snapshotEntityCount(snapshot) + proposedNewCount(report)
```
where `snapshotEntityCount(snapshot) = Object.values(snapshot).flat().length` (unchanged from the
original draft) and `proposedNewCount(report)` counts create-shaped decisions whose entity has no
matching live-snapshot row (§(a)'s appendage step) — the exact quantity the worked example's 42 =
40 + 2 exercises. **In `mode: 'inspect'` there are no proposed-new entities (no decisions exist at
all), so `proposedNewCount` is always `0` and Part 2 collapses to the simpler live-only equality the
original draft assumed** — the simpler form holds, just only in the mode where it's actually true.

Both parts must fail loudly (not silently pass on an empty roster) if a new entity type is added to
`INGESTIBLE_ENTITIES` or the Context wiring (Slice 3) without a matching `CHILD_OF` entry, or if a
future change to proposed-new construction drops an entity — Part 1 catches misfiling, Part 2
catches dropping. The existing `'General'` fallback already prevents a *decision* from being
dropped; these invariants are what prevent a *census roster entry* from being dropped or misfiled,
a distinct failure mode since roster entries exist even with zero decisions.

### (d) Empty-camp state (not-set-up vs. understood)

**Problem:** a fresh camp with zero groups reads, under `stateOf`'s existing "zero decisions →
understood" default, as `Groups: understood` — false confidence indistinguishable from a camp that
has 40 correctly-imported groups and simply nothing pending.

**Resolution:** this is a **caller-assigned** state, not something `stateOf` infers from decisions
(decisions don't exist for a domain nobody has touched yet) — `buildRootMapModel` checks
`snapshot[entityType].length === 0` for each child's backing entity type(s) *before* falling back to
`stateOf`'s decision-based default, and only in that specific empty-backing-table case assigns
`state: 'not_set_up'` to both the child roster (there are no roster entries, only a placeholder) and
the child node itself (canvas dot renders a fifth, distinct visual, not folded into `'absent'` —
`'absent'` per the port ADR means "positive evidence this domain doesn't apply," `'not_set_up'`
means "this domain applies and nobody has touched it yet," a different claim).

**[R3] `not_set_up` is scoped to the five `REQUIRED_AREAS` children only — it does NOT cover all
eight `CHILD_OF` children, and the original draft over-claimed this.** Verified against
`src/engine/readiness.js:37-84`: `REQUIRED_AREAS` covers exactly five keys — `tiers` (→ "Age
Divisions" child), `groups` (→ "Groups"), `days` (→ "Days"), `timeblocks` (→ "Time Blocks"),
`activities` (→ "Activities"). Three `CHILD_OF` children have **no** required-readiness backing:
`locations` and `anchors` (Fixed Events) are explicitly `OPTIONAL_AREAS` — "a camp with zero
locations builds a week fine" (`readiness.js:82`) — and `cohorts` (Units) is not tracked by
`getReadiness` at all; it is auto-seeded to a single "Main" cohort (`ensureCohort` utility) and in
practice is never actually empty. Leaning on `getReadiness` for all eight would mean
`not_set_up` **can never fire** for Locations, Fixed Events, or Units — an empty Locations roster
would render `'understood'` (false confidence, the exact bug this state exists to prevent) on day
one of a fresh camp, the opposite of the intent.

**Resolution — two distinct empty treatments, one token:**
- **Required-5 (Age Divisions, Groups, Days, Time Blocks, Activities):** `buildRootMapModel` checks
  `snapshot[entityType].length === 0` for that child's backing entity type *before* falling back to
  `stateOf`'s decision-based default, and assigns `state: 'not_set_up'` — the one new, fifth
  visual/canvas token (muted/dashed, distinct from `understood`'s calm token and from `absent`'s
  existing token) — reusing `getReadiness`'s existing `required`-readiness rows as the source of
  truth for "this needs setup," per child, not a second empty-table heuristic invented here.
- **Optional-3 (Locations, Fixed Events, Units) and Context (§(g), also optional by definition):**
  **no new token.** Per Red Hat's explicit instruction, the distinction lives entirely in the
  panel's empty-state **copy**, not in a second canvas/roster state enum value. An empty optional
  child keeps `state: 'understood'` (there genuinely is nothing wrong, and a camp is allowed to
  never have Fixed Events) but `RootMapPanel` renders a **different, honest empty message** —
  `"Optional — none yet. [Open in {Screen} →]"` — instead of the required-5's `"Everything here
  looks right"` copy, which the panel selects by checking whether the child's key appears in
  `OPTIONAL_AREAS` (already-existing data, not a new lookup table). This satisfies "calm at first
  glance, honest on inspection" without inventing a state the required-5's real `not_set_up` token
  would then be diluted by.

A camp past its initial setup will never see `not_set_up` on the required-5 domains it has already
configured — this state is specifically for the fresh-camp / mid-onboarding case the audit worried
about; the optional-3's "none yet" copy can persist indefinitely and correctly, since a camp with
zero Fixed Events forever is not a defect.

Worked example: a brand-new camp bootstraps, imports nothing yet, opens Roots in inspect mode (§(e)).
`snapshot.groups = []`, `getReadiness` reports `groups` required-and-not-ready. `Groups` child node
renders `state: 'not_set_up'` with roster `[]`; the panel shows "Nothing set up here yet — [Open in
Groups & Units →]." In the same camp, `snapshot.locations = []` too — `Locations` is `OPTIONAL_AREAS`,
so its child node stays `state: 'understood'`, but the panel (recognizing `locations` is optional)
shows "Optional — none yet. [Open in Locations →]" rather than "Everything here looks right," which
would be actively misleading for a domain the director hasn't touched, without misusing the
required-5's `not_set_up` token for a domain that was never required.

### (e) Inspect mode's file-less data path

**No report, no `planItems`, no dry-run.** Confirmed per Red Hat HIGH-3: `ingestReconcile` (the
diff engine `buildReconciliationReport` is built from) requires a source file and is not called at
all in inspect mode.

**Data path:**
1. A new pure fetch, `fetchCensusSnapshot()` (lives in `src/ingest/existingSnapshot.js`, which
   already exists specifically to read live entities via `localClient.list` outside the diff
   pipeline — reuse, not a new file), issues the same eight `localClient.list(...)` calls
   `ReconciliationScreen`'s `fetchReadiness` already makes, **but returns them under the
   canonical table-name keys `CHILD_OF`/`DOMAIN_OF` use** — `{ cohorts, tiers, groups,
   days_of_operation, time_blocks, locations, activities, anchor_activities }` — **not**
   `fetchReadiness`'s aliased `{ days, timeBlocks, anchors }` shape (§(a)'s R1 fix). The two
   functions are intentionally separate and stay separate: `fetchReadiness` keeps feeding
   `getReadiness`/`COLLECTION_FOR` exactly as today (unmodified), and `fetchCensusSnapshot` feeds
   `buildRootMapModel`'s roster construction in **both** modes (import mode calls both fetches;
   inspect mode calls only `fetchCensusSnapshot`, since there is no readiness bar to render in
   inspect mode). `fetchCensusSnapshot` also issues **plus** two new calls for Slice 3's Context
   wiring: `template_overlays` filtered client-side to rows whose `label` is one of
   `FieldTripDrawer`'s `PRESET_STAMPS` (`'Field Trip' | 'Special Event' | 'Service Project'`) and
   `day_override_templates` (already listed today for readiness, reused as-is).
2. `buildRootMapModel(null, { snapshot, mode: 'inspect' })` — called with `report: null` (no report
   object exists in inspect mode; `rootMapModel.js`'s `reportToLanes` call is skipped entirely when
   `mode === 'inspect'`, short-circuiting straight to the roster-from-snapshot path described in (a)
   — this is the one branch point `buildRootMapModel` needs, not a parallel implementation).
3. No `answers`, no `dismissedGaps`, no tray, no commit bar — `ReconciliationScreen`'s existing
   `mode` prop (new, defaulting to `'import'` to keep the current import-flow call site unchanged)
   gates all of that machinery off in one place: when `mode === 'inspect'`, the tray/commit bar JSX,
   `applying`/`rememberNotes` state, and the `ReconstructionMoment` curtain-raiser are all skipped —
   inspect mode never had an import to "settle" into.

**Mounting as a route:** `src/App.jsx`'s `SCREENS` map gains one entry, `roots: ReconciliationScreen`
(the screen already accepts props; inspect mode just calls it with `mode="inspect"` and no
`baseInputs`/`sourceLabel`/`onCommitted`/`onDiscard`/`factCount`/`isFirstImport` — all of which are
either import-only or already optional). A wrapper is not needed: `AppShell`'s existing
`Screen = SCREENS[screen] || TiersScreen` pattern renders `ReconciliationScreen` directly for the
`'roots'` screen key, passing `mode="inspect"` as a fixed prop from the `SCREENS`-adjacent render
site (matching how `'schedule:manual'` vs `'schedule:generated'` already thread a fixed `route` prop
through one shared component via `SCHEDULE_ROUTE_BY_SCREEN` — Roots follows that exact precedent,
no new pattern). A sidebar entry ("Roots" or "Camp Map," copy TBD by whoever owns the nav label
pass) is added to `Sidebar.jsx`'s nav item list, landing on `screen: 'roots'`.

**Editing:** unchanged from import mode — every roster row and every node's "Open in {Screen} →"
button routes through the same `screenForNode`/`onNavigate('groups')`-style deep-link
(`rootMapNav.js`, unmodified) that already exists. Roster rows add one new interaction: clicking a
roster entry (not just the child's "Open in..." button) also calls `onNavigate(targetScreen)` — it
does not open an inline editor. Camp Setup screens remain the only place data is edited; Roots
(either mode) is read/navigate-only, per the audit's explicit "do not rebuild Camp Setup inside
Roots."

### (f) Load-race guard

**Reuses `requestGenRef`, does not need its own.** `ReconciliationScreen` already owns exactly one
`requestGenRef`-gated async load effect (today driven by `baseInputs`/import re-parse); inspect mode
is a second *trigger* for the same effect shape, not a second guard mechanism. Concretely: the
effect's dependency array gains `mode`, and when `mode === 'inspect'` the effect body calls
`fetchCensusSnapshot()` + `buildRootMapModel(null, {snapshot, mode:'inspect'})` instead of
`buildReconciliationReport(baseInputs)` — same `myGen = ++requestGenRef.current` /
`if (requestGenRef.current !== myGen) return` guard around every await, unchanged. This matters
because inspect mode is reachable via sidebar navigation, and a director could plausibly navigate
away and back (or the mount effect could double-fire under StrictMode) faster than
`fetchCensusSnapshot`'s several `localClient.list` calls resolve — the existing last-issued-wins
discipline already protects against exactly that class of stale-overwrite bug, and duplicating it
in a second ref would be the kind of parallel mechanism this codebase's "one source of truth"
discipline (see `domainRollup.js`'s comments throughout) argues against.

### (g) Context wiring (Slice 3)

**Import mode:** unchanged — `Context` has no entry in `DOMAIN_OF`/`CHILD_OF`, stays `absent`, zero
children, exactly as shipped. Nothing in this ADR changes import-mode Context.

**Inspect mode:** `Context`'s two children — `Field Trips / Special Events` (one child, since both
share `template_overlays` and the audit's root/domain table in §5 groups them under one label; a
`Service Project` stamp also falls here) and `Day Overrides` — get real rosters built from the two
new snapshot calls in (e):
- `Field Trips / Special Events` roster: one entry per `template_overlays` row whose `label` is a
  `PRESET_STAMPS` member, `name` = the overlay's `label` + its `day_id`/date context (exact display
  string is a small copy decision left to Maker, not architecturally load-bearing), `state:
  'understood'` (no decision concept applies in inspect mode — see (a)), routed via a new
  `screenForNode` entry, `Context: 'schedule:manual'` or wherever `FieldTripDrawer` is actually
  reachable from (Maker confirms the exact screen key against `FieldTripDrawer`'s current mount
  point; it is used inside `ScheduleScreen`, not a standalone screen, so `onNavigate` target is
  `'schedule:manual'`/`'schedule:generated'` per whichever route the overlay's `template_id`
  resolves to — this is data-lookup work, not a new architectural surface).
- `Day Overrides` roster: one entry per `day_override_templates` row, reusing the existing
  `DayOverridesScreen`/`'dayoverrides'` `SCREENS` key already in `App.jsx` — this deep-link already
  exists and needs no new plumbing.
- `Context`'s domain-level `state` in inspect mode: **[R3, consistent with (d)'s revised policy]**
  always `'understood'`, never `'not_set_up'` — Context is not a `REQUIRED_AREAS` member (it isn't
  tracked by `getReadiness` at all), so per (d)'s scoping rule it follows the **optional-3
  treatment**, not the required-5 treatment: an empty Context (both rosters empty) keeps
  `state: 'understood'` at the canvas/roster level, and the panel shows the same "Optional — none
  yet" copy convention (d) defines for Locations/Fixed Events/Units, worded for Context — "Nothing
  scheduled yet — [Open in Schedule →]." This is the same outcome the original draft's ad-hoc
  Context-specific carve-out reached, but it is now one policy applied consistently to all four
  optional children instead of a fifth bespoke rule; no new token is introduced for Context beyond
  the required-5's `not_set_up`. (`'absent'` is still never used for Context in inspect mode —
  absent means "positive evidence this domain doesn't apply to ingestion," a claim only import mode
  makes.)

**Invariant test (Slice 3, accepted MEDIUM from Red Hat):** `domainRollup.test.js` gains an
assertion that `INGESTIBLE_ENTITIES.every(e => !isContextOnlyEntity(e))` — concretely, that no
string in `extractEntities.js`'s `INGESTIBLE_ENTITIES` array is ever added as a `CHILD_OF`/
`DOMAIN_OF` key that maps to `'Context'`. This guards the exact regression the audit named: a future
parser widening `INGESTIBLE_ENTITIES` to include, say, `field_trips` as a spreadsheet-ingestible
entity would silently re-phantom Context's "only-authored-in-app" identity without this test
catching it. The test imports `INGESTIBLE_ENTITIES` from `src/ingest/extractEntities.js` and
`DOMAIN_OF`/`CHILD_OF` from `domainRollup.js` directly — no new fixture needed.

## Files/modules affected

Changed:
- `src/ingest/rootMapModel.js` — `mode` param, `snapshot`-driven roster construction per child,
  `not_set_up` state assignment, inspect-mode short-circuit around `reportToLanes`.
- `src/components/reconciliation/domainRollup.js` — no vocabulary change (`DOMAINS`/`DOMAIN_OF`/
  `CHILD_OF` untouched by Slice 2); Slice 3 adds Context's inspect-only child data source, not new
  `DOMAIN_OF`/`CHILD_OF` keys (Context still has none, by design — see (g)).
- `src/components/reconciliation/RootMapPanel.jsx` — renders `RosterList` in the node-selection
  branch; suppresses tray/decision-only affordances when `mode === 'inspect'`.
- `src/components/reconciliation/rootMapNav.js` — new `Context` entries in `DOMAIN_SCREEN`/
  `CHILD_SCREEN` (Slice 3).
- `src/screens/ReconciliationScreen.jsx` — new `mode` prop (`'import' | 'inspect'`, default
  `'import'`); import mode now calls **both** `fetchReadiness()` (unchanged, readiness-only) and
  `fetchCensusSnapshot()` (new, roster-only, canonical keys); inspect mode calls only
  `fetchCensusSnapshot()` and skips tray/commit/`ReconstructionMoment`; reuses existing
  `requestGenRef`.
- `src/ingest/existingSnapshot.js` — gains `fetchCensusSnapshot()`, returning the canonical
  table-name-keyed snapshot object (§(a)/(e), R1) — the two new Context `list` calls plus the
  existing eight, all under `CHILD_OF`-matching keys. Deliberately does not touch or alias
  `fetchReadiness`'s existing aliased-key `collections` object.
- `src/App.jsx` — `SCREENS` gains `roots: ReconciliationScreen`, rendered with a fixed
  `mode="inspect"` prop at the render site (same pattern as `SCHEDULE_ROUTE_BY_SCREEN`).
- `src/components/layout/Sidebar.jsx` — new nav entry for `screen: 'roots'`.

New:
- `src/components/reconciliation/RosterList.jsx` — presentational, panel-only, no canvas
  involvement. Props: `roster`, `threshold` (default 8), `groupField` (opportunistic, e.g. `'group'`
  for Groups; `null`/absent for Activities/Locations — see (b), R4).
- Test files for each of the above: `rootMapModel.test.js` extended (not replaced) with both parts
  of the census-completeness invariant (c) — the per-entity-type attribution check (Part 1) and the
  live-plus-proposed-new total (Part 2) — and `not_set_up`/optional-empty cases (d, scoped to the
  required-5 only, with a characterization case per optional-3 child + Context asserting they stay
  `'understood'` when empty); `RosterList.test.jsx` new, including the "(no age division)" bucket and
  the Activities-has-no-grouping-field case; `domainRollup.test.js` extended with the
  ingestible-overlap invariant (g); `existingSnapshot.test.js` extended with `fetchCensusSnapshot`,
  asserting its returned keys match `CHILD_OF`'s key set exactly (the regression test for R1).

Unchanged: `rootMapLayout.js`, `RootMap.jsx` (canvas/SVG layer), `reconciliationCards.jsx`,
`reconciliationReport.js`, `reportToLanes.js`, `reconciliationTriage.js`, `commitIngest`/`ingest.js`.

## Reused vs. new

Reused: `CHILD_OF`/`DOMAIN_OF` (roster buckets by the same mapping, run over snapshot data instead
of decisions, now with matching keys — R1), `REQUIRED_AREAS`/`OPTIONAL_AREAS` from `readiness.js`
(source of truth for the required-5 vs optional-3 `not_set_up` scoping — R3, not a new heuristic),
`fieldUpdate.js`'s `enrichSnapshotRow` `tier_id → tierNameById` join pattern (reused, not
reinvented, for Groups' "Age Division" grouping — R5), `existingSnapshot.js` (already exists for
exactly this file-less live-read purpose), `requestGenRef`'s last-issued-wins pattern (unchanged,
reused as the guard for a new trigger), `screenForNode`/`rootMapNav.js` deep-linking (extended with
two Context entries, not replaced), `SCHEDULE_ROUTE_BY_SCREEN`'s fixed-prop-per-route-key pattern
(copied for `roots`/`mode`), the four-state visual token vocabulary (extended to five with
`not_set_up`, scoped to the required-5 only, not replaced).

New: `RosterList.jsx` (genuinely new — nothing in the codebase today renders a searchable/grouped
list inside this panel), the `roster` array on the model (new field, additive to the existing
canvas-facing shape), `not_set_up` as a fifth state token (required-5 only), the optional-empty
panel-copy branch (no new token, new copy path), `fetchCensusSnapshot()` (new function, canonically
keyed, distinct from and not replacing `fetchReadiness`), the `'roots'` `SCREENS`/sidebar entry (new
route, first time `ReconciliationScreen` is reachable outside the `ImportScreen` takeover). **Not
new, and explicitly rejected**: a Unit-based (`cohorts`) grouping join for Groups — no such join
exists in the codebase (`groups` has no `cohort_id`), and inventing one was the R5 defect; Groups
grouping uses the real, already-existing tier relationship instead.

## ADR required: yes

This is the ADR the audit's Slice 2/4 gate names. It: (1) adds a new, persistent field (`roster`) to
the shared `buildRootMapModel` contract every consumer of Roots reads — a shape change to an
existing pure-module contract; (2) introduces a `mode: 'import' | 'inspect'` branch that changes
`ReconciliationScreen`'s data-fetch path and skips its commit machinery — a non-obviously-reversible
behavior split in a shipped screen; (3) mounts `ReconciliationScreen` as a first-class `SCREENS`
route + sidebar entry for the first time, a routing/IA change; (4) adds a fifth visual state
(`not_set_up`) to the four-state token vocabulary the port ADR fixed. All four meet the
constitution's ADR bar.

## Open questions for Governor

1. **`RosterList`'s exact copy** ("Find in 30...", empty-roster messages per state) is left to
   whoever owns the copy pass — not architecturally load-bearing, flagging so it isn't skipped.
2. **Field Trips/Special Events target screen resolution** (g) needs the exact `template_overlays →
   schedule route` lookup confirmed against `FieldTripDrawer`'s actual mount point before Maker
   starts; this ADR specifies the mechanism (route via `template_id` → `schedule_templates.kind`)
   but not the literal code, since it's a one-query lookup, not new architecture.
3. **Sidebar label and icon for the new `roots` entry** — "Roots"? "Camp Map"? — a product/copy
   decision, not technical.
4. **Where `RosterList`'s row click should go** — this ADR specifies it navigates via
   `onNavigate(targetScreen)` exactly like the existing "Open in..." button, with no deep-link to
   the *specific* entity (e.g. it opens Groups & Units generally, not scrolled/filtered to "Bogrim").
   That's a real UX gap for a 40-row roster — flagging as a candidate follow-up (deep-linking with a
   focus/highlight param) rather than solving it here, since none of the target screens
   (`GroupsScreen` etc.) currently accept a "highlight this row" prop; adding that is its own small
   scoped change, not blocking this ADR.
5. **Accepted duplicate fetch in import mode** (§(e), R1 resolution): `ReconciliationScreen` now
   calls both `fetchReadiness()` and `fetchCensusSnapshot()`, which overlap on the same eight
   `localClient.list` reads under two different key schemes. This is a real, if minor, inefficiency
   — flagged rather than silently accepted. Leaving it unmerged is the smaller/safer change for this
   ADR (each function keeps a single, unambiguous key contract its one consumer already trusts); a
   follow-up that has `fetchReadiness` derive its aliased view from `fetchCensusSnapshot`'s canonical
   one (collapsing to one fetch, two projections) is a reasonable Slice-5-or-later cleanup, not
   something to fold into this already-large change.

## Where this ADR would tell Red Hat "no"

One point in the audit I'd push back on if asked: **§(d)'s reuse of `getReadiness` for `not_set_up`
assignment couples Roots' rendering to the readiness hub's required-row list more tightly than the
rest of this design couples anything else.** If `getReadiness`'s `required` set ever changes shape
(e.g. a row becomes conditionally required), `not_set_up` silently follows it with no test coupling
the two beyond the census-completeness invariant in (c), which checks counts, not state semantics.
This is the right call for now (one source of truth beats a second heuristic) but it is a coupling
worth naming rather than discovering later — a `not_set_up`-specific characterization test against
`getReadiness`'s current required-row shape, not just the count invariant, should be part of Slice
2's test-first pass, and I'm adding that expectation here rather than leaving it implicit.
