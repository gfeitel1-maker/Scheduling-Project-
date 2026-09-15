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
//      than to not notice.
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
export const DOMAIN_STATE_MIGRATIONS = new Map([
  [11, 'cohort de-duplication re-points time_blocks.cohort_id and anchor_activities.cohort_id'],
  [12, 'group de-duplication re-points template_slots.group_id'],
  [14, 'tier de-duplication re-points groups.tier_id'],
  [15, 'activity de-duplication re-points template_slots.activity_id and activities.weather_alternative_id'],
  [21, 'schedule_templates identity repair — re-points template_slots/schedule_snapshots at a kept or re-minted template row'],
  [23, "backfills schedule_templates.kind = 'generated' where it was NULL or empty"],
  [24, 'repoints orphaned template-scoped rows at a surviving template'],
  [26, 'retires orphan template_slots rows'],
  [27, 'backfills schedule_templates.week_id from the camp default week'],
  [32, 'backfillLocations — mints locations rows and sets activities.location_id'],
])

// DELIBERATELY NOT IN THE SET ABOVE, though they do run UPDATE against a table
// the document models. Each writes a field the document does NOT carry, so no
// divergence is possible:
//   v9  — camps.signing_secret (host-only; hostOnlyExclusion.test.js pins that
//         it never follows into the document)
//   v22 — device_identity.first_sync_completed_at (host-local table)
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
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 16, 17, 18, 19, 20, 22, 25, 28, 29, 30,
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
