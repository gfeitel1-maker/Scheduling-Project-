---
title: T115-locations-ingest-create-name-first
document_type: ticket
status: open
created: 2026-08-22
task_class: database-sync
governing_docs: [docs/governance/GOVERNANCE_INDEX.md, docs/adr/2026-08-15-locations-concurrent-create-collision.md]
archive_when: the locations ingest-create writes name before camp_id (matching the UNIQUE_FIRST_FIELD guard), with a test pinning the op order
---

# T115 — Locations ingest-create writes camp_id before name (orphan-row risk)

**Surfaced by the Electives Slice 3a Red Hat re-review (2026-08-22), pre-existing.**

`locations` is registered in `UNIQUE_FIELD_ENTITIES` / `UNIQUE_FIRST_FIELD`
(unique `name` per camp), and its **authored** create writes `name` first (the
`createRecord` guard enforces it). But the **ingest** create path in
`electron/ops/ingest.js` (~L1087) writes `camp_id` before `name` — the exact
ordering the `UNIQUE_FIRST_FIELD` guard exists to prevent
(`src/data/setupCrudRepository.js:53-63`).

If two devices ingest the same location name concurrently before syncing, the
loser's `name` op collides at sync (`detectUniqueFieldCollision`) — detected, not
a crash — but its row already carries `camp_id` with no accepted `name`, i.e. a
permanently orphaned blank-name `locations` row with no clear UI cleanup path.

The elective_sets ingest-create was reordered to name-first during Slice 3a
(`commitElectiveCandidates`); this ticket does the same one-line reorder for the
locations ingest-create, plus a test pinning `name.seq < camp_id.seq`. Low
frequency, real state-integrity gap.
