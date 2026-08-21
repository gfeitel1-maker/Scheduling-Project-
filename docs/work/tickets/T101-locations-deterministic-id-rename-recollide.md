---
title: T101-locations-deterministic-id-rename-recollide
document_type: ticket
status: open
created: 2026-08-20
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-15-locations-concurrent-create-collision.md, docs/adr/2026-08-15-locations-import-export-roundtrip.md]
archive_when: an owner/Architect decision records whether the deterministic-id create paths (M4 ingest + the T81 CSV importer) get a rename-then-recollide mitigation or explicitly accept the hazard, and any chosen mitigation ships with a test
---

# T101 — Locations deterministic-id rename-then-recollide hazard (owner/Architect decision)

**Surfaced by Red Hat during T81 review (2026-08-20).** Pre-existing on the M4 ingest path; NOT
introduced by T81 (T81 reverted its interactive-create extension of this pattern).

## The hazard

`deriveLocationId(campId, trimmedName)` derives a location's id from its NAME. The deterministic-id
create paths (M4 Host ingest `electron/ops/ingest.js`, and the T81 CSV-template importer) resolve by
exact name then mint that id when absent. But a director can RENAME a location later (LocationsScreen)
— the row keeps its id, its name changes. If the original name is then created/imported again:
`deriveLocationId` yields the SAME id, `locations.ensureExists` is `INSERT OR IGNORE` (silent no-op on
the existing renamed row), and the subsequent field writes silently OVERWRITE the renamed row's
name/capacity/notes. Silent data corruption; every activity at the renamed place reverts.

`docs/adr/2026-08-15-locations-concurrent-create-collision.md` option (d) rejected deterministic ids
for *interactive* creates for exactly this reason; the M4 roundtrip ADR accepted it for *batch* ingest
(which has an explicit commit/review gate) and shipped with this residual open. T81's interactive
extension was reverted, but the residual remains on the two batch/importer paths.

## The decision (why this is a ticket, not an auto-fix)

The owner already ruled once (rejected option d for interactive creates). This is the mirror question
for the batch/importer paths: **accept the residual** (rare; batch paths have a review gate; M3c merge
can heal) **or add a mitigation** — e.g. detect-and-reject on id-collision-with-different-name (like
`detectUniqueFieldCollision` extended to the id case): if `deriveLocationId(name)` lands on an existing
row whose current name ≠ the incoming name, surface a conflict instead of silently overwriting.

## Definition of done

- A recorded owner/Architect decision: accept-as-residual (with rationale, in the relevant ADR) OR
  ship the collision-detection mitigation.
- If mitigation: it covers both `electron/ops/ingest.js` (M4) and ActivitiesScreen's `confirmImport`,
  with a test pinning that a create whose derived id collides with a renamed row is rejected/surfaced,
  not silently overwritten.

## Related

- T81 (deterministic importer ids) — extended the deterministic pattern; interactive-create extension
  reverted, batch importer kept.

## Decision (2026-08-20, owner): BUILD the mitigation — deterministic disambiguated fallback id

Owner chose to build the mitigation rather than accept the residual. Design:

**The two silent-corruption points** (confirmed in code):
- `resolveOrCreateLocationId` (`electron/ops/ingest.js:948`): if `deriveLocationId(camp_id, name)`
  already exists, it silently REUSES that row — so an imported "Pool" binds to a renamed
  "Swimming Pool" row (the two collapse).
- `commitCreate` (`ingest.js:965`) → projection `INSERT OR IGNORE INTO locations` (`projections.js:234`):
  the subsequent field writes silently OVERWRITE the renamed row's name back to the imported one.

**Mitigation:** a shared helper `resolveLocationCreateId(db, campId, trimmedName)` used at BOTH create
points (and consulted by `ActivitiesScreen`'s T81 importer path where it mints a location):
1. `base = deriveLocationId(campId, trimmedName)`.
2. No row with `base` id → use `base` (normal path, unchanged).
3. Row with `base` id whose current name **=== trimmedName** → reuse `base` (normal resolve-by-name).
4. Row with `base` id whose current name **differs** (a rename-recollide) → mint a deterministically
   disambiguated id: the smallest `n ≥ 2` such that `${base}:${n}` is free OR already holds a row named
   `trimmedName`; use that. So the new "Pool" becomes a DISTINCT row from the renamed "Swimming Pool",
   never overwriting or collapsing it.

**Why deterministic-fallback over hold-as-conflict:** it needs no UI, doesn't interrupt a batch import,
and is **cross-device convergent** — two devices re-importing "Pool" after the same synced rename both
scan the same state and derive the same `${base}:${n}`, so they merge (identical to how base
`deriveLocationId` already converges two devices creating the same name), no fork. A held-conflict
alternative was considered but rejected as heavier and UI-dependent for a rare, auto-resolvable case.

**Scope:** the two ingest create points + the T81 importer path + `restore.js`'s rebind (INV-2) must all
resolve through the shared helper so they agree. Red Hat gate: cross-device determinism/convergence +
op-log replay of the disambiguated id + the `:${n}` scan's stability under concurrent pre-sync imports.
