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
