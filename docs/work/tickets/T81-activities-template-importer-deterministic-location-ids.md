---
title: T81-activities-template-importer-deterministic-location-ids
document_type: ticket
status: open
created: 2026-08-16
governing_docs: [docs/governance/constitution/CONSTITUTION.md, docs/governance/GOVERNANCE_INDEX.md]
related_tickets: []
related_adrs: [docs/adr/2026-08-15-locations-import-export-roundtrip.md, docs/adr/2026-08-15-camp-locations-entity.md, docs/adr/2026-08-15-locations-concurrent-create-collision.md]
related_specs: []
archive_when: "the ActivitiesScreen CSV-template importer's location creation is aligned to the deterministic, resolve-by-exact-name-first pattern the M4 Host ingest path uses (deriveLocationId, case-sensitive), OR the importer is retired in favor of the M3b picker + M4 ingest, with a test pinning cross-device id identity; and this ticket is merged with owner sign-off"
---

# T81 — Route the ActivitiesScreen CSV-template importer to deterministic location ids

**Sequencing: AFTER the camp-locations initiative (M5 + M6) lands.** Deferred deliberately by the
owner (2026-08-16) — not urgent, not a correctness bug in a shipped M1–M4 path, but a real
consistency gap worth closing once the initiative's feature slices are done.

**Task class:** database-sync-adjacent (touches cross-device id determinism on a create path).
**Risk:** low-medium — client-side (`src/screens/ActivitiesScreen.jsx`) create path, a separate
entry point from the Host ingest pipeline; behavior-preserving except for the id/dedupe policy.

## The gap

Two different create policies exist for the same `locations` entity:

- **Host ingest (M4, `electron/ops/ingest.js`)** — resolves a place name → existing row by EXACT
  name, and mints only when absent via `deriveLocationId(camp_id, trimmedName)`
  (`electron/ops/locationId.js`): **cross-device deterministic, case-sensitive/TRIM-only**, matching
  the v32 `UNIQUE(camp_id, name)` and `restore.js`'s INV-2 rebind.
- **ActivitiesScreen CSV-template importer** (`src/screens/ActivitiesScreen.jsx`, `confirmImport` /
  `createLocation`) — resolves case-**insensitively** and mints with **`crypto.randomUUID()`**.

Consequence: the same room name imported via the template importer on two paired devices can mint
**two different `locations.id`s** for one place — the exact cross-device fork the whole locations
initiative exists to close. It also diverges on case-sensitivity (the importer folds "Pool"/"pool"
into one row; every other locations surface treats them as two mergeable rows per M3c).

## Context / provenance

- Flagged by Code Reviewer at M3a, Red Hat at M4, and named in the M4 ADR
  (`docs/adr/2026-08-15-locations-import-export-roundtrip.md` §D7 open question #4). Note the ADR's
  §D7 prose describing this importer as writing the **frozen `location` free-text column is STALE** —
  the code already resolves to `location_id`; the real, still-live gap is the **non-deterministic
  mint**, confirmed by Red Hat's M4 re-verify reading the actual `ActivitiesScreen.jsx` create path.
- **PR #70** (`fa94516`, merged 2026-08-16) improved this importer's preview (surfaces new-vs-reused
  places) but **explicitly kept resolve case-insensitive** — so the determinism gap remains open
  after #70. Originally spawned as background chip `task_3ccc52a8`; superseded by this durable ticket.

## Success predicate

Either:
- **(a) Align** the template importer's location resolve-or-create to the M4 Host pattern: resolve by
  exact name first (reuse ANY existing row — migration-created, picker-created, or ingest-created),
  mint only when absent via `deriveLocationId`, case-sensitive; keep the picker's own inline-create
  policy decision explicit; **check `src/localClient.mock.js` parity**; a test pins that the same CSV
  imported on two independent DBs yields byte-identical `locations.id`; OR
- **(b) Retire** the importer's bespoke create path in favor of the M3b picker + M4 ingest if those
  now cover its use cases, with the equivalent cross-device-identity test.

## Gate notes

Red Hat worth including (create-path change touching cross-device id determinism). Must reconcile
with #68's `UNIQUE_FIELD_ENTITIES` exact-name create rejection and M3c's near-duplicate merge — the
resolve-by-exact-name-first design avoids tripping #68 (it reuses the existing row). Reconcile the
case-sensitivity UX consequence with PR #70's preview copy ("pool" vs "Pool" → two mergeable rows,
not silent reuse) so the two don't contradict.
