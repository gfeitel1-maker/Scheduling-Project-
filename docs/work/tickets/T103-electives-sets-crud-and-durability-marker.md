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

## Out of scope (later tickets)

Cell rendering + inline in-context create (T104/T105); the atomic cell-content / mutual-exclusion write
path (T104 — the correctness-critical seam); import recognition of flattened electives.

## Review loop

Architecturally significant (schema migration + sync registration). **Maker (test-first) → Red Hat
(migration + sync-registration completeness; the non-reusable-never-in-durable-inventory invariant) →
Security (IPC permissions surface) → Code Reviewer → Verifier → Grader.**

## Coordination

`elective_sets` projection writable-fields change + v36 may intersect the `shoresh-v1-closure-audit`
peer's PROJECTIONS registry guard — notify before landing.
