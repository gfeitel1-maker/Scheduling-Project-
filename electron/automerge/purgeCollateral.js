// T202 follow-up (drift surface): the single source of truth for what a camper purge does — and
// does not — reach among the tables the Automerge document does NOT replicate.
//
// WHY THIS EXISTS. purgeCamperRecord rebuilds SQLite from a freshly-regenerated document, which
// reprojects ONLY the modeled (document-replicated) entities. Every table NOT in MODELED_ENTITIES is
// therefore collateral of that rebuild — UNLESS the purge explicitly preserves it (the signing/
// identity keys, 5b). That accounting used to be hand-written in three narrations that had no
// mechanism keeping them in sync: PURGE_NOT_RECOVERABLE_NOTICE (hostKeyPreservation.js), the step-5
// header comment (purgeSupportCommand.js), and SECURITY.md's "Camper-record purge" section. This
// module makes the categorization a single exported value; purgeCollateral.test.js then pins it to
// the actual schema — the same authority the rebuild/projector uses (MODELED_ENTITIES) — so a future
// table added outside MODELED_ENTITIES fails the build until it is categorized here, and the two
// prose narrations are asserted to enumerate the same wiped set.
//
// This is NOT purge behavior — purgeCamperRecord does not read these arrays to decide what to delete
// (the rebuild's "reproject only the modeled entities" IS the behavior). These arrays are the
// DESCRIPTION of that behavior, kept honest against the schema by the test.

// Lost camp-wide as an accepted, separately-documented tradeoff — the narrated collateral set. Each
// is a host-only, device-local table (schema.sql marks them "NEVER included in any full-sync
// SELECT/payload"): reconciliation provenance, import evidence, offline write/restore queues, and
// local diagnostic ledgers. None round-trips back via the fresh document, so all lose their state.
export const PURGE_WIPED_TABLES = [
  'conflicts',
  'import_evidence',
  'import_decisions',
  'open_reconciliation_decisions',
  'pending_writes',
  'pending_restores',
  'device_health_events',
  'projection_failures',
  'source_aliases',
  'compound_cell_decisions',
  'location_word_decisions',
  'declined_two_row_splits',
]

// Emptied for the WHOLE ledger (not just the purged camper) — Trash, Restore's prior values, and
// ingest-undo history. Called out on its own in the notice because it is history, not camp state.
export const PURGE_LEDGER_TABLES = ['operations']

// Preserved BYTE-IDENTICAL across the purge by restorePreservableKeys (5b) — the load-bearing
// device-identity artifacts. See hostKeyPreservation.js for the full rationale. (camps.signing_secret
// and camps.signing_public_key are COLUMNS on the modeled `camps` table, not their own tables, so
// they are not in this table-level partition — the notice/SECURITY.md speak to them directly.)
export const PURGE_PRESERVED_TABLES = ['host_signing_key', 'device_identity_key']

// Non-modeled but NOT lost camp state: recreated by the schema on rebuild, self-re-establishing, or
// stub-seeded on receipt. `devices` is stub-seeded per the device-FK-seeding ADR; `locks`,
// `schema_migrations`, `domain_state_migration_pending`, and `device_identity` are recreated empty by
// the schema; `rendezvous_sequence` is a disposable publish counter that re-establishes itself
// (deliberately out of preservation scope — hostKeyPreservation.js). Listed so the schema-drift test
// can prove the partition covers EVERY non-modeled table, leaving no table silently uncategorized.
export const PURGE_INFRASTRUCTURE_TABLES = [
  'devices',
  'locks',
  'schema_migrations',
  'domain_state_migration_pending',
  'device_identity',
  'rendezvous_sequence',
]

// The complete accounting: every non-modeled table falls into exactly one bucket. The test asserts
// this union equals (schema.sql CREATE TABLEs) minus MODELED_ENTITIES.
export const ALL_NON_MODELED_TABLES = [
  ...PURGE_WIPED_TABLES,
  ...PURGE_LEDGER_TABLES,
  ...PURGE_PRESERVED_TABLES,
  ...PURGE_INFRASTRUCTURE_TABLES,
]
