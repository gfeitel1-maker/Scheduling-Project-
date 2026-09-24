// WHICH MIGRATIONS CHANGE WHAT THE CAMP *MEANS*, not just what shape it is in.
//
// From an external architecture review (item 2), and it is correct as a rule:
// the Automerge document is the authoritative state and SQLite is a projection
// of it. A migration that edits domain rows in SQLite alone changes something
// the document does not know about — and `projectAll`'s delete-reconcile will
// quietly undo it at the next merge. `projector.js`'s empty-document guard does
// NOT catch this: by its own comment it refuses only a *totally* empty document,
// and a partially-divergent one passes.
//
// IT CANNOT HAPPEN TODAY, and saying why is the point of writing this down. A
// `.automerge` file only exists for a database that has run a build from the
// document era, and such a database is already at v57 or higher — so every
// migration that touches domain state (all of them below v52) is unreachable
// for a document-bearing camp. The order at startup is also correct for the
// other case: `openLocalDb` migrates, and only then does `ensureSeeded` build
// the document from the migrated rows.
//
// So this exists for the NEXT one. Two mechanisms, deliberately small:
//
//   1. Every version is classified here, and a test fails if a new migration is
//      added without a classification. That forces the author to decide rather
//      than to not notice. The classification is then checked two ways, because
//      one way had a blind spot: migrationDomainState.test.js reads localDb.js
//      as text (sees inline SQL only), and migrationWriteTrace.test.js RUNS the
//      chain against the era fixtures with the db handle instrumented (sees
//      every statement actually executed, including one a helper issued).
//   2. At startup, if a migration from this set ran on a launch where a document
//      already exists, the sync node does not start (main.js). The device keeps
//      working on its own — this is a local-first app — but it will not
//      replicate state the document is about to overwrite.
//
// WHY NOT AUTO-REPAIR. The obvious fix, re-seeding the document from the
// migrated SQLite, is wrong: a document holds history SQLite does not, including
// tombstones for records deleted on other devices. Re-seeding would resurrect
// every one of them across the camp. The correct repair is to apply the same
// change THROUGH the document, which a generic mechanism cannot author. So this
// detects and refuses; it does not guess.

/**
 * Migrations that edit rows of modeled (replicated) domain tables — not just
 * table shape. Each entry names what it does so the classification can be
 * checked rather than trusted.
 */
import { appendOp, DELETE_FIELD, DOCUMENT_OUTCOME } from '../ops/operations.js'

export const DOMAIN_STATE_MIGRATIONS = new Map([
  [11, 'cohort de-duplication re-points time_blocks.cohort_id and anchor_activities.cohort_id'],
  [12, 'group de-duplication re-points template_slots.group_id'],
  [13, 'time_blocks de-duplication DELETEs duplicate rows before adding UNIQUE(camp_id, cohort_id, name)'],
  [14, 'tier de-duplication re-points groups.tier_id'],
  [15, 'activity de-duplication re-points template_slots.activity_id and activities.weather_alternative_id'],
  [21, 'schedule_templates identity repair — re-points template_slots/schedule_snapshots at a kept or re-minted template row'],
  [23, "backfills schedule_templates.kind = 'generated' where it was NULL or empty"],
  [24, 'repoints orphaned template-scoped rows at a surviving template'],
  [26, 'retires orphan template_slots rows'],
  [27, 'backfills schedule_templates.week_id from the camp default week'],
  [32, 'backfillLocations — mints locations rows and sets activities.location_id'],
  [70, 'days_of_operation de-duplication re-points template_slots/anchor_activities/elective_sets/elective_occurrences.day_id (T205)'],
])

// DELIBERATELY NOT IN THE SET ABOVE, though they do run UPDATE against a table
// the document models. Each writes a field the document does NOT carry, so no
// divergence is possible:
//   v9  — camps.signing_secret (host-only; hostOnlyExclusion.test.js pins that
//         it never follows into the document)
//   v22 — device_identity.first_sync_completed_at (host-local table)
//   v67 — devices.libp2p_peer_id (T162). The migration NULLs this column on every
//         row, but it is a device-local admission/routing anchor the document has
//         never carried (libp2pPeerId.migration.test.js pins that it is neither
//         replicated nor read by authorize()), so no replica can diverge from it.
// If a future migration writes a MODELED field of any of these tables, it
// belongs in the set above, not here.

/**
 * Migrations that change only table SHAPE (create/alter/drop/index/recreate),
 * or that write host-local tables the document never carries. Safe at any
 * lifecycle point.
 *
 * Listed explicitly rather than derived as "everything else", so that a new
 * version is an ERROR until someone classifies it — which is the whole
 * mechanism. See migrationDomainState.test.js.
 */
export const SCHEMA_ONLY_MIGRATIONS = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 16, 17, 18, 19, 20, 22, 25, 28, 29, 30,
  31, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
  51, 52, 53, 54, 55, 56, 57, 58, 59,
  // v60 adds users.auth_sig (a Host signature over existing credential fields) and backfills it on
  // the Host. Schema-only: the column is table shape, and the backfill DERIVES an attestation from
  // values already present — it changes no domain row value and no camp meaning. A Client's backfill
  // is a no-op (no host key), so it is also not a value change there.
  60,
  // v61 adds users.cred_version + re-signs (T172 replay defense) — derived attestation, not a domain-meaning change.
  61,
  // v62 creates sync_health_events (T174). A new host-local diagnostic table; touches no domain row.
  62,
  // v63 adds import_decisions (T173 slice 1) — a new host-local, never-replicated table (like v54's
  // compound_cell_decisions). Table shape only; the document does not model it and never will.
  63,
  // v64 adds import_decision_failures (T173 slice 1) — a new host-local, never-replicated table.
  // Table shape only; the document does not model it and never will.
  64,
  // v67 (T162) creates device_identity_key (host-local, never replicated) and NULLs
  // devices.libp2p_peer_id so every device re-binds its persistent libp2p identity via
  // TOFU. Both touch only fields the document does not carry — see the note above.
  67,
  // v65 (T180) adds anchor_activities.unit_ids and backfills it from the legacy singular
  // unit_id. Schema-only by the same reading as v51: the backfill RE-EXPRESSES a fact the
  // row already carried (one division, now written as a one-element list) in a new column —
  // it does not change what any camp MEANS. Deliberately, a group_ids snapshot row is NOT
  // converted: inferring the director's division from a group list is the very derivation
  // T180 exists to remove, and doing it here would be a real domain-state change.
  65,
  // v66 (T194) creates the seven participant tables and ALTER-adds
  // elective_set_activities.capacity_mode/capacity_limit. Schema-only, and
  // deliberately kept that way: the seven tables are created EMPTY (new
  // entities — no camp has a row to change), and the capacity columns are
  // populated for existing rows by the ADD COLUMN DEFAULT, which is table
  // shape, not a row write.
  //
  // A conditional backfill UPDATE was written and then REMOVED to keep this
  // classification honest. Both capacity columns are MODELED fields, so an
  // UPDATE of them here would be a post-v52 domain-state write — exactly what
  // the "nothing above v52 changes domain state" property forbids, and what
  // projectAll's delete-reconcile would quietly undo. The legacy value is not
  // lost: camper_headcount is retained untouched, so translating a non-NULL
  // one (of which none exist on any surveyed database) stays available as a
  // write through the DOCUMENT, which is where it belongs.
  66,
  // v67 has no migration block in THIS tree — the number is RESERVED by
  // unmerged work on the claude/shoresh-rendezvous-wan-handoff-5f211b
  // worktree (a committed, unpushed v67_down.js), so v68 (T195) skips
  // straight past it rather than claim it. Classified schema-only (there is
  // nothing here to classify any other way) so the "no gaps" check below
  // stays meaningful rather than needing a carve-out for an unused number.
  67,
  // v68 (T195) ALTER-adds elective_set_activities.status, defaulted to
  // 'confirmed' for every existing row. Schema-only: the DEFAULT gives every
  // pre-existing row the SAME meaning it already had (a hand-authored or
  // previously-imported offering was always, implicitly, confirmed) — no
  // UPDATE re-decides anything. The importer that writes 'potential' is new
  // code exercised after this migration, not part of it.
  68,
  // v69 (T210) creates rendezvous_sequence, a device-local, never-synced singleton table (same
  // exclusion class as device_identity_key/host_signing_key). Schema-only: it touches no table
  // the document models, and no existing row's meaning changes.
  69,
  // v70 is DELIBERATELY NOT here — see DOMAIN_STATE_MIGRATIONS above. It is
  // the FIRST domain-state migration above v52 to actually be reachable
  // (T205), and durably records that fact via domain_state_migration_pending
  // so a plain restart cannot silently re-enable sync past it.
  //
  // v71 (T181) DROPs anchor_activities.recurrence_level and
  // elective_sets.recurrence_level. Schema-only: no application code path has
  // ever written a non-default value to this column on either table (the
  // T181 sweep, docs/work/tickets/T181-recurrence-level-is-dead-data.md,
  // established that as evidence), so dropping it changes no camp's meaning
  // — there is no value being discarded, only an always-default column.
  71,
  // v72 (T233) creates the `tombstones` table (empty) — a Host-signed purge-tombstone denylist,
  // docs/adr/2026-09-19-multi-device-erasure-propagation.md. Schema-only: the table is created
  // EMPTY (a new entity — no camp has a row to change), and the migration writes no domain row
  // value. Tombstones ARE document-modeled and replicate, but that is a new-entity addition, not a
  // change to any existing modeled entity's row meaning — the same reading as v66's seven empty
  // participant tables above.
  72,
  // v73 (T241) relaxes ten UNIQUE(camp_id[, cohort_id], name) constraints to plain indexes and
  // adds two nullable/defaulted columns to the host-local `conflicts` table
  // (docs/adr/2026-09-23-merge-unique-collision-schema-and-conflict-shape.md). Schema-only: no
  // existing row's VALUE changes on any modeled entity — every table rebuild is a straight
  // SELECT * copy, and the constraint relaxation only changes what future writes are ALLOWED to
  // do, not what any current row means. `conflicts` itself is not document-modeled (host-local
  // history), so its additive columns are outside domain-state's scope entirely.
  73,
  // v74 (T243) adds elective_assignment_runs.finalized_at/finalized_by (nullable) and creates
  // the empty elective_run_outer_snapshots table. Schema-only: nothing writes either yet (T244+
  // builds the write path), so no existing camp's domain row value changes.
  74,
])

/** True if applying `version` can change what the camp means. */
export function isDomainStateMigration(version) {
  return DOMAIN_STATE_MIGRATIONS.has(version)
}

/**
 * The domain-state migrations inside a span `(from, to]` — i.e. those that
 * would run when a database at version `from` is opened by a build at `to`.
 * `from === 0` is a fresh database, which has no document yet by definition.
 */
export function domainStateMigrationsIn(from, to) {
  const out = []
  for (const version of DOMAIN_STATE_MIGRATIONS.keys()) {
    if (version > from && version <= to) out.push(version)
  }
  return out.sort((a, b) => a - b)
}

// T205 part D: the per-process migrationSpans WeakMap only reports a span for
// the launch that actually RAN a migration — on the NEXT launch (any process,
// any restart), `from === to` and domainStateMigrationsIn returns [], even
// though the risk this guard exists for has not gone away. This reads a
// DURABLE record instead: a domain-state migration that actually changed rows
// (see localDb.js's v70 block, the first to populate this table) inserts a
// row into domain_state_migration_pending, and it stays there — deliberately,
// per this file's "WHY NOT AUTO-REPAIR" — until something resolves it by
// republishing the reconciled state through the document.
export function unresolvedDomainStateMigrations(db) {
  return db
    .prepare('SELECT version, detail, created_at FROM domain_state_migration_pending WHERE resolved_at IS NULL')
    .all()
}

// The single decision main.js's sync-start guard makes, pulled out so it can
// be unit-tested without booting Electron or a real document. Refuse to start
// sync when EITHER signal says a domain-state migration has run against a
// camp that already has a document: the per-launch span (migrationSpanFor,
// for the launch that ran it) OR the durable marker (unresolvedDomainStateMigrations,
// for every launch after — the fix for the one-launch-only defect).
export function shouldRefuseSyncForDomainMigration({ docExists, riskyThisLaunch = [], unresolvedMarkers = [] }) {
  if (!docExists) return false
  return riskyThisLaunch.length > 0 || unresolvedMarkers.length > 0
}

// T205 round 2, FIX 2: closes the "durable marker never resolved" defect —
// left as-is, a camp with a pre-T205 duplicate would refuse sync on every
// launch FOREVER once v70 dedupes it. The correct repair (this file's own
// "WHY NOT AUTO-REPAIR" above, and Amendment 2's original framing) is to
// apply the SAME change through the document, not to re-seed it: the
// migration already deleted these rows from SQLite and recorded exactly
// which entity_ids in the marker's `detail` (see localDb.js's v70 block),
// so this authors a document delete (tombstone) for each one via the
// ordinary appendOp path — the same primitive an interactive delete uses —
// then marks the marker resolved. Idempotent: appendOp's DELETE_FIELD on an
// entity_id already absent from SQLite is a no-op at the projection layer
// (applyProjection has nothing to delete), so calling this twice, or from
// two devices independently, is harmless — which is exactly why FIX 3
// (deterministic survivor selection) matters: two devices dedupe the SAME
// duplicate pair down to the SAME survivor and record the SAME loser id, so
// their independent resolves converge on the SAME document tombstone rather
// than each other's now-orphaned pointer.
export function resolvePendingDomainStateMigrations(db, { device_id = null } = {}) {
  const pending = db.prepare('SELECT * FROM domain_state_migration_pending WHERE resolved_at IS NULL').all()
  const resolvedVersions = []

  for (const marker of pending) {
    let payload
    try {
      payload = JSON.parse(marker.detail)
    } catch {
      // FOR FUTURE MIGRATION AUTHORS: a marker whose `detail` is not this
      // resolver's {note, losers} JSON shape is left UNRESOLVED forever by
      // this loop — never guessed at, never resolved by accident. A future
      // domain-state migration that wants its own marker auto-resolved must
      // write `detail` in this exact shape (or extend this function to
      // recognize its own), or plan for a human/future-ticket resolution path
      // instead.
      continue // not a structured marker this resolver understands — leave it, never guess
    }
    const losers = Array.isArray(payload.losers) ? payload.losers : []

    // FAIL CLOSED (T205 round 3, Red Hat HIGH): appendOp never THROWS on a
    // document-write failure — it returns the op with op[DOCUMENT_OUTCOME] set
    // to 'failed' instead of 'applied' (electron/ops/operations.js). The
    // return was previously discarded and resolved_at was set unconditionally,
    // so a transient document-write failure would still clear the marker, sync
    // would resume, and a peer's projectAll delete-reconcile would RESURRECT
    // the exact duplicate row v70 deleted — the CRDT-merge resurrection this
    // ticket exists to prevent, with the safety net disarmed. days_of_operation
    // IS modeled, so a healthy write's outcome is 'applied'; ANY other outcome
    // ('failed', 'not-modeled', 'deferred', 'engine-off') means the tombstone
    // did not land and must count as not-yet-resolved.
    //
    // A PARTIAL batch fails the WHOLE marker, not just the failed loser: this
    // module's own design already relies on appendOp's DELETE_FIELD being an
    // idempotent no-op for an entity_id already gone from SQLite or already
    // absent from the document (see the module comment above), so re-running
    // every loser on a later retry is safe and cheap — there is no reason to
    // track partial progress inside one marker.
    let allApplied = true
    for (const { entity, entity_id } of losers) {
      const op = appendOp(db, { entity, entity_id, field: DELETE_FIELD, value: 1, author_user_id: null, device_id })
      if (op[DOCUMENT_OUTCOME] !== 'applied') allApplied = false
    }

    if (!allApplied) continue // leave resolved_at NULL — retried on the next call/launch

    db.prepare('UPDATE domain_state_migration_pending SET resolved_at = ? WHERE version = ?').run(
      new Date().toISOString(),
      marker.version
    )
    resolvedVersions.push(marker.version)
  }

  return resolvedVersions
}
