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
  'device_health_events',
  'projection_failures',
  'source_aliases',
  'compound_cell_decisions',
  'location_word_decisions',
  'declined_two_row_splits',
  // T267 (v77, docs/adr/2026-09-26-fixed-recurring-event-identity-model.md): a host-local worklist
  // of fixed/recurring events the migration's name-match backfill could not resolve to exactly one
  // catalog activity. Holds director-relevant data (the event's `name`, `candidate_count`, `kind`)
  // that a human has not yet acted on and that the migration will never regenerate (it already ran,
  // schema_migrations reports v77) — real work-in-progress, not a derivable diagnostic, so a purge
  // loses it the same way it loses import_evidence/compound_cell_decisions above.
  'fixed_event_identity_gaps',
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
  // applied_authority_log / authority_cache (T331, docs/adr/2026-10-02-distributed-revocation-
  // authority.md): device-local caches derived by replaying the camp_authority_log Automerge
  // collection (electron/automerge/authorityReplay.js). The DOCUMENT COLLECTION ITSELF is not
  // purged (purge/rebuild operates on this device's local SQLite projection, not the synced
  // document) — so wiping these two cache tables loses nothing: the next projection pass
  // re-verifies and re-replays the untouched camp_authority_log from scratch and repopulates both
  // tables identically, which is exactly the "re-verifies and carries forward the revocation set,
  // never resets it" discipline this ADR requires (the carry-forward comes from the document
  // never having been purged, not from preserving these derived rows byte-identically).
  'applied_authority_log',
  'authority_cache',
  // peer_tombstone_reports (T322 S3a, docs/adr/2026-09-19-multi-device-erasure-propagation.md's
  // 2026-10-01 addendum): a peer's self-reported set of (tombstone id, version) pairs it has
  // verified-and-projected — erasure-PROPAGATION metadata (which peer applied which purge, at what
  // version), never camper data. Mechanically it is WIPED by the whole-device rebuild exactly like
  // every other non-modeled table (nothing in restorePreservableKeys/hostKeyPreservation.js names
  // it — only host_signing_key/device_identity_key get byte-identical preservation), so it is not
  // PURGE_PRESERVED_TABLES. It belongs here, not in PURGE_WIPED_TABLES, because it SELF-RE-ESTABLISHES
  // via ordinary operation, the same reasoning `devices` (stub-seeded on receipt) already uses in
  // this bucket: every still-connected peer re-reports its applied-tombstone set on its very next
  // `authenticate` (electron/auth/connectionAuth.js), so the table repopulates itself without any
  // special-cased restore code, unlike PURGE_WIPED_TABLES' genuinely-unrecoverable director
  // work-product (import_evidence, compound_cell_decisions, ...). A peer that never reconnects simply
  // reads as UNKNOWN again until it does — the same honest "never certainty about a peer it cannot
  // hear from" behavior S3a/S3b already require, not a regression a purge introduces.
  //
  // Red Hat confirmed (2026-10-01, T322 S3a round 2, tied to #686's digest-key leak): the table's
  // columns are (device_id, tombstone_id, version, reported_at) only — no camper name, no camper
  // field of any kind in the table definition or anywhere in its one write path
  // (connectionAuth.js's persistAppliedTombstones, fed by syncNode.js's `SELECT id, version FROM
  // tombstones`). tombstone_id is always `tombstones.id`, which is always `campers.id` for the
  // purged camper (purgeSupportCommand.js mints one tombstone per purge, entity hardcoded
  // 'campers', id = the purged camper's own id) — so whether this column is PII-bearing reduces to
  // whether `campers.id` is. For every camper minted under the current scheme (the only mint site,
  // `camperIdentityResolver.js` -> `mintCamperId()`, `camper2:<randomUUID()>`), it is opaque and
  // carries nothing — a materially different outcome from #686's cleartext digest-map leak.
  //
  // CONDITIONAL, not structural, per Red Hat's finding — stated plainly rather than overclaimed:
  // this is true because no pre-T321-style camper (`camper1:<camp>:name:<cleartext-nameKey>`,
  // `electiveDerivedIds.js`) exists in any live camp today, which is an accepted, owner-flagged,
  // point-in-time premise of T321's own ADR (`docs/adr/2026-10-01-camper-id-high-entropy-format.md`,
  // "Tombstones & digest keys already written" — pre-T321 ids are NOT re-keyed, and the ADR itself
  // asks the owner to confirm this "no live data" reading), not a guarantee this table or its write
  // path enforces on its own (`persistAppliedTombstones` validates shape/type of an incoming id,
  // never its format). If that premise is ever wrong — a restored pre-T321 snapshot promoted to a
  // real camp, or a resolver regression that re-mints an old-style id — this table would carry
  // whatever `tombstones.id` carries, with no gate here catching it, same as `tombstones` itself
  // already would. Tracked as a residual, not fixed in this slice: fixing it means validating id
  // format at the tombstone-mint or report-persist boundary, which is T321/T233 surface, not S3a's.
  'peer_tombstone_reports',
  // peer_last_addresses (T328 Slice 1, docs/adr/2026-10-02-wan-discovery-transport-ladder.md,
  // Slice 1): this device's own local cache of a trusted peer's last-observed multiaddr, written
  // only from an authenticated connection (syncNode.js's onPeerAdmitted). Same bucket, same
  // reasoning as peer_tombstone_reports immediately above — it does not replicate at all, nothing
  // preserves it across a purge, and it is not lost camp state: the next time that peer completes
  // an authenticated connection it is remembered again, with no special-cased restore code. A
  // purge that drops it only means the next startup falls through to discovery (mDNS/rendezvous)
  // sooner — the pre-Slice-1 behavior.
  'peer_last_addresses',
  // punch_identity / peer_punch_memory (T348, Rung 1): device-local punch identity and the per-peer
  // remembered session. Same bucket as peer_last_addresses: nothing replicates or preserves them, and
  // a purge only costs the next reconnect its zero-signaling shortcut (a fresh identity is minted and
  // peers re-learn it on the next punched session).
  'punch_identity',
  'peer_punch_memory',
]

// The complete accounting: every non-modeled table falls into exactly one bucket. The test asserts
// this union equals (schema.sql CREATE TABLEs) minus MODELED_ENTITIES.
export const ALL_NON_MODELED_TABLES = [
  ...PURGE_WIPED_TABLES,
  ...PURGE_LEDGER_TABLES,
  ...PURGE_PRESERVED_TABLES,
  ...PURGE_INFRASTRUCTURE_TABLES,
]
