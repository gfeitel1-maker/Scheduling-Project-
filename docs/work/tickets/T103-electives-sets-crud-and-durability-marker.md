---
title: T103-electives-sets-crud-and-durability-marker
document_type: ticket
status: in-progress
created: 2026-08-20
task_class: database-sync
governing_docs: [docs/adr/2026-08-20-electives-authoring.md, docs/adr/2026-08-20-in-context-knowledge-and-durability-tiers.md]
related_adrs: [docs/adr/2026-08-20-electives-authoring.md]
archive_when: shipped and merged
---

# T103 — Electives sets: management CRUD, IPC, and the durability marker

**First ticket of the ratified electives-authoring ADR.** The isolated, low-risk data foundation —
**no schedule-cell writing** (that is T104, the race-prone seam). Test-first.

## Scope

1. **v36 migration — durability marker.** Add `is_reusable INTEGER DEFAULT 1` (and, if the b/c
   distinction needs it, a nullable `scope` column) to `elective_sets`, both places
   (`electron/db/schema.sql` + `electron/db/localDb.js`, `CURRENT_SCHEMA_VERSION=36`) +
   `electron/db/rollback/v36_down.js`. Existing rows = reusable (durable). Extend the `elective_sets`
   projection writable fields; add to `DOMAIN_TABLE_COLUMNS`; mock parity. Migration test
   (fresh-vs-migrated byte-identity; `getSchemaVersion===36`).
2. **IPC surface (create/edit/delete sets + members).** Wire create/edit `elective_sets`, add/remove
   `elective_set_activities`, and the existing `deleteElectiveSet` cascade into `electron/main.js` +
   `electron/preload.js` + `src/localClient.js`. Permissions unchanged (staff r/w, admin delete).
3. **Durability semantics.** A one-off set (`is_reusable=0`) is filtered from every reuse/durable surface
   (palette query, management-list query, Context inventory). Tier (c) durable sets surface in Roots
   **Context**, never the census (ADR D2). Add the invariant test: a non-reusable set never appears in
   the durable inventory query.
4. **Capacity + eligibility fields** on the offering (per-member capacity via existing `locations`;
   age/eligibility on the set/members) — schema + projection + mock, no engine assignment.
   **RESOLVED (2026-08-20): no new schema needed.** An `elective_set_activities` member is an
   `activity_id` reference, so every member inherits capacity (`activities.location_id` →
   `locations.capacity`) and eligibility (`activities.eligible_tier_ids`/`eligible_group_ids`) from its
   underlying activity row unchanged. Adding parallel columns on the set would duplicate authoritative
   activity data. Item closed as already-covered.

## Out of scope (later tickets)

Cell rendering + inline in-context create (T104/T105); the atomic cell-content / mutual-exclusion write
path (T104 — the correctness-critical seam); import recognition of flattened electives.

## Review loop

Architecturally significant (schema migration + sync registration). **Maker (test-first) → Red Hat
(migration + sync-registration completeness; the non-reusable-never-in-durable-inventory invariant) →
Security (IPC permissions surface) → Code Reviewer → Verifier → Grader.**

## Coordination

`elective_sets` projection writable-fields change + v36 may intersect the `shoresh-v1-closure-audit`
peer's PROJECTIONS registry guard — notify before landing. **Done:** peer confirmed the guard is
parity-based and `is_reusable` (renderer-writable) is registered in `PROJECTIONS[elective_sets].fields`;
`projectionsCoverage.test.js` green.

## Review outcome (2026-08-20)

Implemented scope 1–3 (item 4 resolved as already-covered, above). Reviews: **Security 5/5**, **Red Hat
4/5** (no defects shipped; two MEDIUM *forward* risks — the durability invariant has no production caller
yet and the generic `list('elective_sets')` IPC is an unguarded parallel read route — both carried into
**T105** as binding constraints), **Code Reviewer 4/5** (merge-ready; the item-4 doc reconciliation above
closes its one MEDIUM). Two LOW notes recorded: `v36_down.js` uses `DROP COLUMN` (SQLite ≥3.35 — fine on
the bundled binary; version note is a nice-to-have) and the invariant is convention-not-structural (watch
item for T104/T105 when a second consumer appears). Deterministic gate: see the full `npm run verify` run.

## ⚠️ Pre-PR renumber obligation (2026-08-21)

**This ticket's number COLLIDES with a merged origin/main ticket** (main owns a different
`T103-location-disambiguation-suffix-namespace`).
Confirmed with the peer that T105–T111 is clear. **Before opening the PR**, renumber this ticket to
**T110** and update all references (the other 2026-08-20 ADRs/specs,
sibling tickets T105–T109, the INDEX, the ~35 in-code comments citing the bare number, and the
gate-report JSON filename). Bare-number citations are currently disambiguated by their full doc-path,
so the collision is inert until merge — but must be resolved for numbering integrity.
