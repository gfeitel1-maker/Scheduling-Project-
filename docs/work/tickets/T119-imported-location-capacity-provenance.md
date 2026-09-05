---
title: T119-imported-location-capacity-provenance
document_type: ticket
status: completed
created: 2026-09-05
task_class: database-sync
governing_docs:
  - docs/governance/GOVERNANCE_INDEX.md
  - docs/adr/2026-08-15-camp-locations-entity.md
  - docs/adr/2026-08-22-roots-as-hub-setup-ia.md
related_adrs:
  - docs/adr/2026-08-15-camp-locations-entity.md
archive_when: every imported location's capacity is queryable as import-defaulted vs director-confirmed via the same op-log source mechanism as activity-rule provenance, the gap is surfaced on the Roots attention list and the Locations screen, and a regression test pins that commitCreate writes an explicit capacity op on import — DONE.
---

# T119 — Imported location capacity is indistinguishable from a confirmed capacity=1

## Status

**Completed — implemented as designed.** Filed as a ticket, not an ADR — see "Why a ticket, not an ADR" below.

Frontmatter note: the sibling ADR this design cites throughout
(`docs/adr/2026-09-05-generated-route-render-time-location-contention.md`) exists on a sibling
branch (`claude/anchor-contention-rule`) not yet merged to `main` — not visible from this worktree,
so it reads as dangling here (`check:governance`). Dropped from `governing_docs`/`related_adrs` for
now; restore once that branch lands and this ticket is rebased (Governor to confirm). `task_class`
was also corrected from `data-quality` (not a row in `GOVERNANCE_INDEX.md` §3-8) to `database-sync`
— the core of this work is the importer writing an op-log field write and reading it back via
`lastKnownFieldSources`; the UI markers are secondary.

Copy note: the per-cell marker's tooltip shipped as **"Imported — no one has confirmed how many
groups fit here."**, not this design's draft ("Imported — capacity not confirmed…") — the Locations
screen's column header reads "Groups at once", not "capacity," and Governor asked for the tooltip to
match the column the director is actually looking at. The attention-list strings ship as drafted
below pending a separate owner-wording pass.

Implementation note: the design's Item 1 covered `buildPlan.js`'s `fieldsFor('locations', ...)`
create path. A second location-mint path exists — `resolveOrCreateLocationId` in
`electron/ops/ingest.js` (D1c: an activity's location minted inline, mid-import, never proposed as
its own `locations` create item) — which bypasses `fieldsFor`/`commitCreate`'s generic field loop
entirely and writes `camp_id`/`name` directly. This path needed its own explicit `capacity` op too;
both paths are now covered and regression-tested
(`electron/ops/ingest.locationRoundtrip.test.js`).

## Problem (restated from the brief)

`locations.capacity` (`electron/db/schema.sql:705`, `NOT NULL DEFAULT 1`, editable in
`LocationsScreen.jsx` as "Groups at once") means "how many groups fit in this room at once."
The spreadsheet importer never sets it — `src/ingest/buildPlan.js:151-159`'s `fieldsFor('locations', ...)`
returns only `{ camp_id, name }`, deliberately leaving capacity to the column default (comment at
`buildPlan.js:153-157`, decision M4 §D1a). Every imported location silently lands at capacity 1.
There is no way today to tell "nobody has ever said what this room holds" from "a director looked
at this room and confirmed it holds exactly one group." A same-day sibling design
(`docs/adr/2026-09-05-generated-route-render-time-location-contention.md`) is about to make
`locations.capacity` load-bearing for a live contention flag on both schedule routes — a wrong,
unlabeled capacity now produces wrong flags, and a director has no way to know the flag is
untrustworthy for that room specifically.

## Candidate approaches considered (divergent pass, 5 isolated frames)

Five isolated cognitive-frame ideation passes (regulator, speedrunner, biology, 3am-on-call,
inversion — 30 raw ideas total) were run before converging. They clustered into four angles:

- **Provenance-on-the-row plays** (regulator's attestation ledger/expiring-trust ideas,
  speedrunner's "reuse `_humanFields`", inversion's "attach a `capacity_source` field to the row
  itself") — converged, independently, on: *the fact of who set this value should travel with the
  data, using whatever mechanism this codebase already uses for exactly that question elsewhere.*
- **Segregate/quarantine plays** (regulator's shadow table, FK-to-signed-attestation record) —
  rejected as traps: this is a single-device-per-camp, single-director app: a foreign key to a
  cryptographically-signed attestation record is solving a multi-party trust problem this app
  doesn't have. Over-engineered relative to the actual ask (Karpathy: "would a senior engineer say
  this is overcomplicated?" — yes).
- **Make the flag robust to bad data instead of fixing the data** (3am's confidence-weighted
  capacity, usage-inferred capacity; biology's habituation/myelination models) — genuinely clever,
  but solves a *different* problem (robustness of the contention flag) than the one asked
  (legibility/correctability of the underlying number for a director). Also nondeterministic and
  hard to test — the schedule engine's whole design principle is a seeded, deterministic PRNG
  (`buildSchedule.js`); inferring capacity from observed placements would make a location's
  effective capacity depend on schedule history, which nothing else in this codebase does. Flagged
  as a legitimate *future* idea for the contention-flag ADR itself, not for this ticket.
- **Split the flag vocabulary at the point of use** (3am's "UNVERIFIED-CONTENTION vs OVERBOOKED",
  inversion's "route unattested capacity to a distinct flag reason") — a real complement, folded
  into the surfacing design below rather than treated as a separate mechanism.

**Trap called out explicitly:** inversion's "reset provenance to confirmed the instant a director
merely opens the edit form" — rejected; provenance must flip only on an actual saved change to the
capacity field, never on a passive view, or the fix launders bad data without anyone deciding
anything.

**Converged pick:** attach provenance to the row via **the codebase's existing field-level
op-log source mechanism** — not a new column, not a new table, not a new confirmation boolean.

## What the codebase already does for exactly this problem (verified against live code)

This is the load-bearing finding, and it is a direct architectural precedent, not an analogy:

1. **Every field write in this app already carries a `source` column** (`operations.source`,
   written by `commitCreate`/`commitField` in `electron/ops/ingest.js:1373-1421`): `'human'` when a
   director types a value, `'import'` (the `IMPORT_SOURCE` constant, `ingest.js:835`) when the
   importer writes it, keyed per-field via the `_humanFields` set threaded through from `buildPlan`
   (ADR 2026-08-09 Decision 2, cited in `buildPlan.js:677-678`).
2. **There is already a generic, tested helper that reads this back**:
   `lastKnownFieldSources(db, entity, entity_id)` (`electron/ops/restore.js:139-152`) — a
   last-write-wins scan over `operations` for one entity, filtered to the entity's `PROJECTIONS`
   fields, returning `Map<field, source|null>`. It is entity-agnostic; it does not know or care that
   it is currently only called for `activities` and (for a different purpose) restore-from-trash.
3. **There is already a pure two-tier classifier over that source**: `tierForField(source,
   evidenceTag)` (`src/utils/ruleProvenance.js:27-31`) — `source == null || source === 'human'` →
   `'confirmed'`, otherwise not human-owned. It is used today for the Activities screen's
   provenance dot (`docs/adr/2026-08-22-roots-as-hub-setup-ia.md` §7): `min_per_week`,
   `eligible_group_ids`, and `location_id` each render a dot when their last op's source is not
   human, batched over IPC in `listImportEvidenceHandler` (`electron/main.js:1462-1480`).
4. **The one thing missing for `locations.capacity` is not a mechanism — it is a single op.**
   Because `buildPlan.js`'s `fieldsFor('locations', ...)` never includes `capacity` in the fields it
   returns, `commitCreate` never writes an `operations` row for that field at all. So
   `lastKnownFieldSources(db, 'locations', locId).get('capacity')` returns `undefined` today for
   every imported location, forever — not `'import'`, just *absent*, indistinguishable at the code
   level from "this field was never written," which happens to be exactly what did happen. There is
   no provenance gap to invent a mechanism for; there is a **missing write**.

This means the fix is not "add a way to know," it is "make the importer actually say what it did,"
using a write path (`commitCreate`) and a `source` semantic (`IMPORT_SOURCE`) that already exist and
are already exercised by every other imported field on every other entity.

## Decision

### Recommendation: make the importer explicitly write `capacity` on location create; read its provenance with the existing helper; surface it on the two existing surfaces (Locations screen row, Roots attention list). No new column, no new table, no schema migration.

**Confidence: high.** Every piece of this reuses an already-shipped, already-tested mechanism
(`operations.source`, `lastKnownFieldSources`, `tierForField`-shaped binary classification, the
Activities-screen provenance-dot pattern, the `attentionList.js` structure-issue pattern). The only
genuinely new code is: one field added to one `fieldsFor` case, one new IPC-batched read (mirroring
`listImportEvidenceHandler` almost line for line), one small UI affordance, and one new
`buildStructureIssues`-style check. Nothing here is a novel data shape or a novel query pattern.

### 1. Importer: `buildPlan.js` writes an explicit `capacity: 1` on location create

`src/ingest/buildPlan.js:158-159` currently:

```js
case 'locations':
  return { camp_id: campId, name }
```

Change to:

```js
case 'locations':
  return { camp_id: campId, name, capacity: 1 }
```

This is the entire behavioral change to the importer. `1` is still the value — the brief is explicit
that the importer genuinely cannot know a room's real capacity from a spreadsheet, and this ticket
does not pretend otherwise. What changes is that `commitCreate` (`ingest.js`) now sees `capacity` in
`fields` and writes an `operations` row for it with `source: IMPORT_SOURCE` (`'import'`), because
`capacity` is not in that item's `_humanFields` set (locations are never director-hand-edited at
import time — there is no location-editing UI inside the import wizard, so `_humanFields` for a
freshly-created location is always empty). No import-flow code needs to know this is happening; it
falls out of the existing `_humanFields`-gated write loop for free.

**Why write the default explicitly instead of leaving it to the SQL column default:** an op-log row
is the only thing this app already checks to answer "who last touched this field," and a column
default produces no op-log row. This is not a stylistic preference — it is the mechanical
precondition for every other part of this design to work.

**Existing imports are unaffected and do not need a backfill.** `lastKnownFieldSources(...).get('capacity')`
returns `undefined` for a location that has never had a `capacity` op — before or after this ship.
`undefined`/`null` and `'import'` are treated identically by the classifier below (see Reused vs
new): both mean "not human-owned." A camp imported before this change and a camp imported after it
read the same way. No migration, no data backfill script, no one-time job.

### 2. Read path: a `locations`-scoped sibling of `listImportEvidenceHandler`

Add `capacitySources` alongside the existing camp-scoped location list read (`electron/main.js`,
new handler mirroring `listImportEvidenceHandler`'s shape at `:1462-1480`, or folded into an
existing locations-read handler if one already batches per-entity data — Maker should check for the
nearest existing locations IPC call before adding a new one):

```js
function locationCapacityProvenanceHandler(token) {
  if (!isNonEmptyString(token)) throw new Error('token is required')
  requireAuthorized(db, { token, action: 'locations.read' })
  const camp = db.prepare('SELECT id FROM camps LIMIT 1').get()
  if (!camp) return {}
  const locationIds = db.prepare('SELECT id FROM locations WHERE camp_id = ?').all(camp.id).map((r) => r.id)
  const result = {}
  for (const locationId of locationIds) {
    const source = lastKnownFieldSources(db, 'locations', locationId).get('capacity') ?? null
    result[locationId] = source == null || source === 'human' ? 'confirmed' : 'unconfirmed'
  }
  return result
}
```

This is a direct copy of the shape at `electron/main.js:1462-1480`, narrowed to one field and a
binary tier (no `evidenceTag`/`observed` distinction — capacity has no import-evidence record the
way activity rules do, so `tierForField`'s three-way tier collapses to two: `'confirmed'` or
`'unconfirmed'`). Reuse `tierForField(source, null)` directly instead of re-deriving the
`source == null || source === 'human'` check inline, so the one place that defines "what counts as
human-owned" stays singular — the inline check above is illustrative; Maker should call the
existing function.

### 3. Locations screen: a provenance affordance on the "Groups at once" cell, matching the Activities-screen dot pattern

`LocationsScreen.jsx`'s `LocationRow` (around `:225-230` for the read view, `:205` for the
`CapacityStepper` edit view) renders capacity today with no distinction at all. Add the same visual
device already established for the Activities-screen provenance dot (`docs/adr/2026-08-22-roots-as-hub-setup-ia.md`
§7): a small, quiet dot/marker next to the capacity value when `capacitySources[location.id] ===
'unconfirmed'`, with a tooltip/title reading **"Imported — capacity not confirmed. Edit to set the
real number."** Not a banner: it is a per-cell marker on a value the director is already looking at
on a screen they already visit for exactly this purpose (editing locations), matching how the
Activities screen already marks unconfirmed rule fields in place rather than interrupting.

**Clearing it requires an actual edit, not a view.** Saving through the existing `save()` handler
(`LocationsScreen.jsx:190`, `onSave(location.id, { ...capacity: Number(capacity)... })`) already
routes through the normal write path, which defaults `source: 'human'` (`syncClient.js:249`,
`:1070`) unless explicitly overridden — no special-casing needed here either. Opening the row into
edit mode without changing the capacity value and clicking Save **does** re-write the field (the
current `save()` always sends `capacity`), which would silently launder an unconfirmed value the
instant a director edits the *name* or *notes* of a room without touching capacity. **This is a
real gap Maker must close**, not a hypothetical: either (a) `save()` only includes `capacity` in the
write payload when it actually changed from `location.capacity`, or (b) the write path is left as-is
and this ticket accepts that any save re-confirms capacity as a matter of policy. Recommend (a) —
it is a small diff (compare before building the payload) and it is the only option consistent with
the trap already called out in Divergence ("provenance must flip only on an actual saved change").

### 4. Roots attention list: one aggregate item, not one per location

Extend `buildStructureIssues` (`src/ingest/attentionList.js:55-89`) with a new check, following the
exact shape of `REQUIRED_EMPTY_AREAS`'s loop but keyed on the new `capacitySources` map (passed in
as an added argument, since `buildAttentionList`/`buildStructureIssues` are declared PURE/no-IO —
the IPC-fetched map is computed by the caller and passed through, same as `decisionsById` already
is for the reconciliation half):

```js
export function buildStructureIssues(collections, capacitySources = {}) {
  if (!collections) return []
  const issues = []
  // ...existing REQUIRED_EMPTY_AREAS loop, unchanged...

  const locations = collections.locations ?? []
  const unconfirmedCount = locations.filter((l) => capacitySources[l.id] === 'unconfirmed').length
  if (unconfirmedCount > 0) {
    issues.push({
      id: 'locations-capacity-unconfirmed',
      name: 'Room capacity',
      why: unconfirmedCount === 1
        ? '1 location was imported without a confirmed capacity.'
        : `${unconfirmedCount} locations were imported without a confirmed capacity.`,
      domainTag: 'Structure',
      sourceKind: 'structure',
    })
  }
  // ...existing groups-no-activities loop, unchanged...
  return issues
}
```

**One aggregate row, not N per-location rows** — matches the existing tally/census-tile pattern
(memory: "census tiles") rather than the reconciliation half's one-row-per-entity pattern, because
this is a setup-completeness fact about the camp ("how many rooms still need a real number"), not a
per-entity decision queue with its own resolution state. Clicking the item should navigate to the
Locations screen (`onNavigate`/`setScreen` — already the pattern every Roots attention row uses),
where the per-row dots from Item 3 above let the director work through them one at a time. This
avoids inventing a second UI for the same underlying list.

## Files/modules affected

- `src/ingest/buildPlan.js` — one-line change to `fieldsFor('locations', ...)`.
- `electron/main.js` — new IPC handler (or an addition to an existing locations-read handler),
  `locationCapacityProvenanceHandler`, mirroring `listImportEvidenceHandler`.
- `electron/preload.js` — expose the new handler if it is a standalone IPC method.
- `src/localClient.js` / `src/localClient.mock.js` — wire the new call through, mirroring however
  `listImportEvidence`/`fieldSources` are already exposed for activities.
- `src/screens/LocationsScreen.jsx` — provenance marker on the capacity cell; fix `save()` to omit
  `capacity` from the write payload when unchanged (Item 3).
- `src/ingest/attentionList.js` — extend `buildStructureIssues` with the new aggregate check.
- `src/screens/RootsHomeScreen.jsx` — thread the new `capacitySources` data through to
  `buildStructureIssues`'s call site (wherever `collections` is already assembled for that call).
- Tests: `src/ingest/buildPlan.test.js` (capacity now present in the locations create fields),
  `electron/ops/ingest.test.js` or a new focused test (a location created via import has a
  `capacity` op with `source: 'import'`), `src/ingest/attentionList.test.js` (new structure-issue
  case), `src/screens/LocationsScreen.jsx`'s existing test file if any (save-omits-unchanged-capacity).

## Reused vs. new

**Reused, unchanged:** `operations.source` and the `'human'`/`'import'` (`IMPORT_SOURCE`) vocabulary
(`electron/ops/ingest.js`); `lastKnownFieldSources` (`electron/ops/restore.js:139`, entity-agnostic,
already used for a different entity); `tierForField`'s human-ownership check
(`src/utils/ruleProvenance.js:27-31`, called with a null `evidenceTag` since capacity has no
import-evidence record); the `listImportEvidenceHandler` shape (`electron/main.js:1462-1480`) as the
template for the new handler; the Activities-screen provenance-dot visual pattern
(`docs/adr/2026-08-22-roots-as-hub-setup-ia.md` §7); the `buildStructureIssues`/`REQUIRED_EMPTY_AREAS`
aggregate-check pattern (`src/ingest/attentionList.js`); `locations.capacity` and the `locations`
table itself (`docs/adr/2026-08-15-camp-locations-entity.md`) — no schema change, no migration.

**New:** one field in `buildPlan.js`'s `fieldsFor`; one small IPC handler; one small classifier call
site; a `capacitySources`-aware overload of `buildStructureIssues`; a small UI marker and a
save-payload fix in `LocationsScreen.jsx`. No new table, no new column, no new flag kind, no new
confirmation mechanism, no banner.

## Why a ticket, not an ADR

This does not meet the constitution's ADR bar: it introduces no new persistent data shape (reuses
`operations.source`, already a first-class op-log column, and `locations.capacity`, already
schema v32), it does not change a contract other modules call (`lastKnownFieldSources` and
`tierForField` are used exactly as they already work; no signature changes), and it makes no
irreversible tradeoff — the importer's one-line change is trivially revertible, and no data is
migrated or destroyed. The closest thing to an ADR-triggering fact is that it reverses an internal
comment in `buildPlan.js` describing an M4 design decision — but that decision lived in a spec
document (`M4 §D1a`), not an accepted ADR, and reversing "leave capacity to the schema default" for
"write the same default explicitly, so it leaves an audit trail" is a data-quality bugfix within the
spirit of that decision (locations are still bare-minimum on import; only the internal write
mechanics change), not a reversal of it.

## Scope

**In scope:** making unconfirmed-vs-confirmed capacity legible and correctable, using existing
mechanisms, on the two constrained surfaces (Locations screen, Roots attention list).

**Explicitly out of scope** (flagged as separate future work, not silently dropped):
- Making the location-contention flag itself robust to unconfirmed capacity (e.g. suppressing or
  softening `OVERLAP` when the underlying capacity is unconfirmed) — this is a real, good idea from
  the divergent pass (3am-on-call frame) and belongs in
  `docs/adr/2026-09-05-generated-route-render-time-location-contention.md`'s own scope or a fast
  follow to it, decided by whoever owns that ADR's Open Questions, not bundled into this ticket.
- A bulk "confirm all remaining at 1" action. Rejected for this ticket, not deferred as an
  oversight: a one-click bulk-confirm defeats the entire purpose (a director confirming N rooms
  they never looked at is functionally identical to today's silent default, just with a checkbox
  that makes it feel reviewed). If the owner wants a faster per-location path, the per-row
  `CapacityStepper` already on the Locations screen is that path.
- Backfilling `capacity` ops for locations imported before this ships. Not needed — see Item 1's
  "existing imports are unaffected" note; the absent-op case and the `'import'`-sourced case read
  identically to the classifier.
- Any change to `cohorts.capacity_source` (an unrelated, pre-existing column storing a fixed enum
  value `'groups_per_slot'` for a different purpose entirely — a naming coincidence, not related
  prior art, and not touched by this ticket).

## Open questions for Governor

1. **Aggregate attention-list item vs. one row per unconfirmed location.** This design recommends
   one aggregate tally row (Decision §4) on the theory that a camp with 15 imported locations
   should not produce 15 attention-list rows for the same underlying fact. If the owner has a
   strong preference either way (or wants the per-location list only once the count is small, e.g.
   ≤3), that is a product call, not a technical one.
2. **Copy for the per-cell marker and the attention-list row** — drafted above ("Imported — capacity
   not confirmed. Edit to set the real number." / "N locations were imported without a confirmed
   capacity.") is a first pass, not final copy; Designer/Governor should sign off on tone before
   Maker ships it, consistent with this project's no-coming-soon-controls and no-banner history of
   being particular about exactly this kind of small, frequently-seen copy.
3. **Should this ship before or alongside the location-contention ADR** (`2026-09-05-generated-route-render-time-location-contention.md`)? That ADR's own Open Question 3 asks for real-data validation of flag noise — an unconfirmed-capacity signal shipping first would let a director triage "is this flag real or is this room's capacity just wrong" before the flag itself goes live on both routes, which may reduce exactly the noise that ADR is worried about. Sequencing recommendation: ship this ticket first or in the same release, not after.
