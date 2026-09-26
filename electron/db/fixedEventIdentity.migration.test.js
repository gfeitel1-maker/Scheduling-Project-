// @vitest-environment node
//
// Migration v77 (T267, docs/adr/2026-09-26-fixed-recurring-event-identity-model.md). Renames anchor_activities to
// fixed_events and gives it a real activity_id, replacing the by-name link
// src/engine/anchorActivityLink.js resolved through (the T62 scar its header describes).
//
// PR 1 scope only: schema + document-key rename + projection registration + backfill. This file
// pins the backfill's three outcomes (zero candidates, two candidates, exactly one candidate),
// the fresh-vs-migrated column-order parity (the column-order trap this repo has been bitten by
// before), and that the rollback restores the original table shape.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openLocalDb, initSchema, getSchemaVersion, CURRENT_SCHEMA_VERSION } from './localDb.js'
import { rollbackV77 } from './rollback/v77_down.js'
import {
  unresolvedDomainStateMigrations,
  shouldRefuseSyncForDomainMigration,
  resolvePendingDomainStateMigrations,
  syncRefusalForDomainMigration,
} from './migrationDomainState.js'

const files = []

afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function tmpFile(tag) {
  const file = path.join(os.tmpdir(), `shoresh-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return file
}

function freshDb() {
  return openLocalDb(tmpFile('v77-fresh'))
}

// A database migrated fully forward, then rolled back to the pre-v77 shape (table named
// anchor_activities, no activity_id column, no fixed_event_identity_gaps table) so v77 can be
// exercised against it — mirroring every other *.migration.test.js's preVNNDb() shape in this file.
function preV77Db(tag = 'v77-migrated') {
  const db = new Database(tmpFile(tag))
  db.pragma('foreign_keys = ON')
  initSchema(db) // fully migrate to current
  rollbackV77(db)
  return db
}

const tableInfo = (db, table) =>
  db.pragma(`table_info(${table})`).map((c) => ({
    cid: c.cid, name: c.name, type: c.type, notnull: c.notnull, dflt_value: c.dflt_value, pk: c.pk,
  }))

const seedCamp = (db, campId = 'camp1') =>
  db.prepare("INSERT INTO camps (id, name, signing_secret) VALUES (?, 'Camp', 'sec')").run(campId)

describe('migration v77: fresh vs migrated equivalence', () => {
  it('declares schema version 77 and renames anchor_activities to fixed_events', () => {
    const db = freshDb()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(CURRENT_SCHEMA_VERSION).toBe(77)
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fixed_events'").get()
    ).toBeTruthy()
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='anchor_activities'").get()
    ).toBeUndefined()
    db.close()
  })

  it('gives fresh and migrated identical fixed_events columns, in the same order', () => {
    const fresh = freshDb()
    const migrated = preV77Db()
    initSchema(migrated)
    expect(tableInfo(migrated, 'fixed_events')).toEqual(tableInfo(fresh, 'fixed_events'))
    fresh.close()
    migrated.close()
  })

  it('declares fixed_events columns in order, activity_id LAST', () => {
    const db = freshDb()
    expect(db.pragma('table_info(fixed_events)').map((c) => c.name)).toEqual([
      'id', 'camp_id', 'cohort_id', 'day_id', 'time_block_id', 'name', 'unit_id', 'span_blocks',
      'is_all_groups', 'group_ids', 'notes', 'schedule_week_id', 'location_id', 'kind', 'unit_ids',
      'activity_id',
    ])
    db.close()
  })

  it('a fresh install has fixed_event_identity_gaps with the declared columns', () => {
    const db = freshDb()
    expect(db.pragma('table_info(fixed_event_identity_gaps)').map((c) => c.name)).toEqual([
      'id', 'camp_id', 'fixed_event_id', 'name', 'candidate_count', 'created_at', 'kind',
    ])
    db.close()
  })

  it('is idempotent — re-running v77 does not duplicate the column or the gaps table', () => {
    const db = preV77Db()
    seedCamp(db)
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a1', 'camp1', 'Lunch')").run()
    initSchema(db) // runs v77
    db.prepare('DELETE FROM schema_migrations WHERE version >= 77').run()
    // Re-running the rename must not throw on a table that no longer has the old name; the
    // migration itself guards with `hasOld = tableExists('anchor_activities')`, so verify the
    // second pass is a genuine no-op on the rename while still safe.
    expect(() => initSchema(db)).not.toThrow()
    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    expect(db.pragma('table_info(fixed_events)').filter((c) => c.name === 'activity_id')).toHaveLength(1)
    db.close()
  })
})

describe('migration v77: backfill resolves fixed_events.activity_id by name-match', () => {
  it('sets activity_id when exactly one catalog activity matches by name', () => {
    const db = preV77Db()
    seedCamp(db)
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-swim', 'camp1', 'Swim')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-one', 'camp1', 'Swim')").run()

    initSchema(db)

    const row = db.prepare('SELECT activity_id FROM fixed_events WHERE id = ?').get('a-one')
    expect(row.activity_id).toBe('act-swim')
    expect(db.prepare('SELECT COUNT(*) c FROM fixed_event_identity_gaps WHERE fixed_event_id = ?').get('a-one').c).toBe(0)
    db.close()
  })

  it('matches case- and whitespace-insensitively (anchorNameKey semantics)', () => {
    const db = preV77Db()
    seedCamp(db)
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-swim', 'camp1', 'Swim  Time')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-one', 'camp1', 'swim time')").run()

    initSchema(db)

    expect(db.prepare('SELECT activity_id FROM fixed_events WHERE id = ?').get('a-one').activity_id).toBe('act-swim')
    db.close()
  })

  it('leaves activity_id NULL and records a gap for zero candidates', () => {
    const db = preV77Db()
    seedCamp(db)
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-zero', 'camp1', 'Mifkad')").run()

    initSchema(db)

    const row = db.prepare('SELECT activity_id FROM fixed_events WHERE id = ?').get('a-zero')
    expect(row.activity_id).toBeNull()
    const gap = db.prepare('SELECT * FROM fixed_event_identity_gaps WHERE fixed_event_id = ?').get('a-zero')
    expect(gap).toBeTruthy()
    expect(gap.candidate_count).toBe(0)
    expect(gap.kind).toBe('no_match')
    expect(gap.name).toBe('Mifkad')
    expect(gap.camp_id).toBe('camp1')
    db.close()
  })

  it('leaves activity_id NULL and records a gap for two-or-more candidates', () => {
    const db = preV77Db()
    seedCamp(db)
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-lunch-1', 'camp1', 'Lunch')").run()
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-lunch-2', 'camp1', 'lunch')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-two', 'camp1', 'Lunch')").run()

    initSchema(db)

    const row = db.prepare('SELECT activity_id FROM fixed_events WHERE id = ?').get('a-two')
    expect(row.activity_id).toBeNull()
    const gap = db.prepare('SELECT * FROM fixed_event_identity_gaps WHERE fixed_event_id = ?').get('a-two')
    expect(gap).toBeTruthy()
    expect(gap.candidate_count).toBe(2)
    expect(gap.kind).toBe('ambiguous')
    db.close()
  })

  it('all three outcomes together in one migration pass — non-vacuity: distinct fixed_events rows land in distinct buckets', () => {
    const db = preV77Db()
    seedCamp(db)
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-swim', 'camp1', 'Swim')").run()
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-lunch-1', 'camp1', 'Lunch')").run()
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-lunch-2', 'camp1', 'lunch')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-one', 'camp1', 'Swim')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-zero', 'camp1', 'Mifkad')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-two', 'camp1', 'Lunch')").run()

    initSchema(db)

    const byId = (id) => db.prepare('SELECT activity_id FROM fixed_events WHERE id = ?').get(id)
    expect(byId('a-one').activity_id).toBe('act-swim')
    expect(byId('a-zero').activity_id).toBeNull()
    expect(byId('a-two').activity_id).toBeNull()
    const gaps = db.prepare('SELECT fixed_event_id, candidate_count, kind FROM fixed_event_identity_gaps ORDER BY fixed_event_id').all()
    expect(gaps).toEqual([
      { fixed_event_id: 'a-two', candidate_count: 2, kind: 'ambiguous' },
      { fixed_event_id: 'a-zero', candidate_count: 0, kind: 'no_match' },
    ])
    db.close()
  })

  it('scopes name-matching to the same camp — a same-named activity in a different camp is not a candidate', () => {
    const db = preV77Db()
    seedCamp(db, 'camp1')
    seedCamp(db, 'camp2')
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-other-camp', 'camp2', 'Swim')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-one', 'camp1', 'Swim')").run()

    initSchema(db)

    // Zero candidates WITHIN camp1, even though camp2 has a same-named row — proves the backfill
    // is camp-scoped, not a global name index (this app is one-camp-per-device in practice, but the
    // migration must not silently cross-link camps if that invariant is ever relaxed).
    expect(db.prepare('SELECT activity_id FROM fixed_events WHERE id = ?').get('a-one').activity_id).toBeNull()
    const scopedGap = db.prepare('SELECT candidate_count, kind FROM fixed_event_identity_gaps WHERE fixed_event_id = ?').get('a-one')
    expect(scopedGap.candidate_count).toBe(0)
    expect(scopedGap.kind).toBe('no_match')
    db.close()
  })
})

describe('rollbackV77', () => {
  it('restores anchor_activities with its original columns and drops the new table', () => {
    const db = freshDb()
    seedCamp(db)
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-swim', 'camp1', 'Swim')").run()
    db.prepare("INSERT INTO fixed_events (id, camp_id, name, activity_id) VALUES ('a1', 'camp1', 'Swim', 'act-swim')").run()

    const result = rollbackV77(db)

    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='anchor_activities'").get()
    ).toBeTruthy()
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fixed_events'").get()
    ).toBeUndefined()
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='fixed_event_identity_gaps'").get()
    ).toBeUndefined()
    const cols = db.pragma('table_info(anchor_activities)').map((c) => c.name)
    expect(cols).not.toContain('activity_id')
    // The row itself survives — only activity_id is lost, same posture as every other *_down.js.
    expect(db.prepare("SELECT name FROM anchor_activities WHERE id = 'a1'").get().name).toBe('Swim')
    expect(db.prepare('SELECT COUNT(*) c FROM schema_migrations WHERE version = 77').get().c).toBe(0)
    expect(result.renamed).toEqual(['fixed_events -> anchor_activities'])
    db.close()
  })

  it('never strands a higher schema version (uses >= not =)', () => {
    const db = freshDb()
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (78, ?)').run(
      new Date().toISOString()
    )
    rollbackV77(db)
    expect(getSchemaVersion(db)).toBeLessThan(77)
    db.close()
  })
})

describe('migration v77: domain-state marker survives a restart (Red Hat HIGH finding)', () => {
  // v77's backfill sets fixed_events.activity_id — a MODELED field — by direct SQL, outside the
  // document. Without a DURABLE marker, sync only refuses on the one launch that ran the migration
  // (migrationSpanFor's WeakMap is per-process); the NEXT launch reports nothing risky, sync
  // silently re-enables, and projectAll's delete-reconcile discards every backfilled activity_id
  // camp-wide on the next peer merge — exactly the T62 scar this ticket exists to close, restored
  // silently. This test simulates that second launch directly against the persisted table, not by
  // re-running the migration block (which would only prove the WeakMap-covered first-launch case).
  it('leaves an unresolved marker that keeps shouldRefuseSyncForDomainMigration true on a simulated restart', () => {
    const db = preV77Db()
    seedCamp(db)
    // A real one-candidate match — the marker is gated on backfilledCount > 0 (Red Hat round 4: a
    // camp where every row lands in a gap changes nothing modeled and must not arm the marker), so
    // this test needs an actual backfill, not just a row to consider.
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-swim', 'camp1', 'Swim')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-one', 'camp1', 'Swim')").run()

    initSchema(db) // runs v77

    // The marker exists, durable (a real table row, not a per-process WeakMap entry) and unresolved.
    const marker = db.prepare('SELECT * FROM domain_state_migration_pending WHERE version = 77').get()
    expect(marker).toBeTruthy()
    expect(marker.resolved_at).toBeNull()

    // Simulate the SECOND launch: migrationSpanFor reports nothing (no migration ran this launch —
    // main.js:3101-3102's WeakMap is per-process and this is a fresh process), so `riskyThisLaunch`
    // is empty. The only remaining signal is the durable marker.
    const riskyThisLaunch = []
    const unresolvedMarkers = unresolvedDomainStateMigrations(db)
    expect(shouldRefuseSyncForDomainMigration({ docExists: true, riskyThisLaunch, unresolvedMarkers })).toBe(true)

    // The marker must not be silently auto-resolved either: resolvePendingDomainStateMigrations
    // only knows how to resolve a `{note, losers}`-shaped marker (v70's row-deletion case) by
    // authoring document tombstones for named losers. v77's marker has no losers-shaped remediation
    // (there is no entity to tombstone; the fix is routing activity_id through the document, PR 2+
    // work), so its `detail` is deliberately NOT that JSON shape — proving it here, not just by
    // reading the migration's comment.
    const resolvedVersions = resolvePendingDomainStateMigrations(db, { device_id: 'device-1' })
    expect(resolvedVersions).not.toContain(77)
    const stillUnresolved = db.prepare('SELECT resolved_at FROM domain_state_migration_pending WHERE version = 77').get()
    expect(stillUnresolved.resolved_at).toBeNull()
    // And the refusal still holds after that resolve attempt — the actual restart-survival property.
    expect(
      shouldRefuseSyncForDomainMigration({
        docExists: true,
        riskyThisLaunch: [],
        unresolvedMarkers: unresolvedDomainStateMigrations(db),
      })
    ).toBe(true)

    db.close()
  })

  // TRIPWIRE (Red Hat round 3): the fix above depends on the v77 marker's `detail` HAPPENING to be
  // unparseable as JSON — that is what makes resolvePendingDomainStateMigrations fall into its
  // "left UNRESOLVED forever" branch instead of treating an empty `losers` array as already-
  // satisfied and clearing resolved_at on the very next call. That property is real today but
  // ACCIDENTAL: nothing stops a future edit to the message in localDb.js's v77 block from turning
  // it into valid JSON (quoting it, making it a bare string literal, reformatting it as
  // `{note: '...'}` `for consistency` with v70) — at which point this exact defect re-arms itself
  // SILENTLY, because the marker still gets written, still looks present in the table, and no
  // other test in this file would catch the change. This test asserts BOTH halves of why that
  // matters: the detail is not JSON-parseable (what makes the failure legible to whoever breaks
  // it), AND the resolver actually leaves it unresolved (the behavior that actually matters) — the
  // first alone would pass while the resolver's semantics drifted elsewhere, and the second alone
  // would leave a future author guessing why an unrelated string edit broke a distant test.
  it('TRIPWIRE: the v77 marker detail must stay non-JSON, or resolvePendingDomainStateMigrations will silently auto-clear it', () => {
    const db = preV77Db()
    seedCamp(db)
    // A real one-candidate match — the marker is gated on backfilledCount > 0 (Red Hat round 4).
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-swim', 'camp1', 'Swim')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-one', 'camp1', 'Swim')").run()
    initSchema(db) // runs v77, writes the marker

    const marker = db.prepare('SELECT detail FROM domain_state_migration_pending WHERE version = 77').get()
    expect(marker, 'expected a v77 marker row to exist — did the backfill-gated write get removed?').toBeTruthy()

    let parseError = null
    try {
      JSON.parse(marker.detail)
    } catch (e) {
      parseError = e
    }
    expect(
      parseError,
      "electron/db/localDb.js's v77 block writes domain_state_migration_pending.detail as a plain " +
        'string that must NOT parse as JSON. If you just made it parseable (quoting it, reformatting ' +
        "it as `{note, losers}` to match v70, etc.), STOP: resolvePendingDomainStateMigrations " +
        '(electron/db/migrationDomainState.js) treats any JSON-parseable detail with no non-empty ' +
        "`losers` array as already-resolved and clears resolved_at on its very next call — silently " +
        're-enabling sync one launch later with fixed_events.activity_id values the document never ' +
        'received (the T62 class defect this marker exists to prevent). There is no losers-shaped ' +
        'remediation for this migration (no entity to tombstone), so `detail` must keep failing ' +
        'JSON.parse until a real document-routed resolution exists (PR 2+) — write a plain, ' +
        'deliberately non-JSON message instead.'
    ).not.toBeNull()

    const resolvedVersions = resolvePendingDomainStateMigrations(db, { device_id: 'device-1' })
    expect(
      resolvedVersions,
      'resolvePendingDomainStateMigrations resolved the v77 marker, which means sync will silently ' +
        're-enable on the next launch while the document never received the backfilled activity_id ' +
        'values — see the comment on this test for why that reproduces the T62 class defect.'
    ).not.toContain(77)
    const stillUnresolved = db
      .prepare('SELECT resolved_at FROM domain_state_migration_pending WHERE version = 77')
      .get()
    expect(stillUnresolved.resolved_at).toBeNull()

    db.close()
  })

  it('writes no marker when the backfill resolves nothing (fresh install, or every row already linked)', () => {
    const db = freshDb() // no legacy anchor_activities rows — rows.length === 0 in the migration
    const marker = db.prepare('SELECT * FROM domain_state_migration_pending WHERE version = 77').get()
    expect(marker).toBeUndefined()
    db.close()
  })

  // Red Hat round 4: `rows` (the WHERE activity_id IS NULL query, taken BEFORE the backfill loop)
  // means "rows that needed a decision," not "rows whose modeled field actually changed." A camp
  // whose fixed events ALL land in fixed_event_identity_gaps ends with activity_id NULL on every
  // row — the value the column already had — so nothing modeled diverged from the document. Arming
  // the marker there would strand that camp's sync permanently for a divergence that never
  // happened, with no in-app way to clear it (the only mechanism, v77_down.js, desyncs schema
  // versions across a paired fleet). `rows.length > 0` was the original (over-broad) condition;
  // this test pins the honest one, `backfilledCount > 0`.
  it('writes no marker when every fixed_events row lands in a gap — nothing modeled diverged', () => {
    const db = preV77Db()
    seedCamp(db)
    // Zero candidates (no matching activity at all).
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-zero', 'camp1', 'Mifkad')").run()
    // Two candidates (ambiguous match).
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-lunch-1', 'camp1', 'Lunch')").run()
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-lunch-2', 'camp1', 'lunch')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-two', 'camp1', 'Lunch')").run()

    initSchema(db) // runs v77 — rows.length is 2, but backfilledCount is 0

    // Non-vacuity: confirm both rows really did land in gaps, not silently skipped.
    expect(db.prepare('SELECT COUNT(*) c FROM fixed_event_identity_gaps').get().c).toBe(2)
    expect(db.prepare('SELECT activity_id FROM fixed_events WHERE id = ?').get('a-zero').activity_id).toBeNull()
    expect(db.prepare('SELECT activity_id FROM fixed_events WHERE id = ?').get('a-two').activity_id).toBeNull()

    const marker = db.prepare('SELECT * FROM domain_state_migration_pending WHERE version = 77').get()
    expect(marker).toBeUndefined()
    db.close()
  })

  it('still arms the marker when SOME rows backfill and SOME land in a gap', () => {
    const db = preV77Db()
    seedCamp(db)
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-swim', 'camp1', 'Swim')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-one', 'camp1', 'Swim')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-zero', 'camp1', 'Mifkad')").run()

    initSchema(db)

    expect(db.prepare('SELECT activity_id FROM fixed_events WHERE id = ?').get('a-one').activity_id).toBe('act-swim')
    const marker = db.prepare('SELECT * FROM domain_state_migration_pending WHERE version = 77').get()
    expect(marker).toBeTruthy()
    expect(marker.resolved_at).toBeNull()
    db.close()
  })

  // T268 (docs cross-check, round 6): T268 reads sync-refusal through
  // syncRefusalForDomainMigration — the SAME generic, version-agnostic query
  // (unresolvedDomainStateMigrations + shouldRefuseSyncForDomainMigration) the
  // startup guard uses, exposed for getSyncStatus's read-only IPC path. It has
  // no special knowledge of version 77; it just reads whatever rows exist in
  // domain_state_migration_pending. This test proves the two sides of that
  // seam actually agree by exercising the REAL v77 migration (not a hand-
  // inserted synthetic marker like electron/main.test.js's T268 fixtures use)
  // and then calling T268's own reader against the result.
  it('T268 seam: syncRefusalForDomainMigration sees the REAL v77 marker and reports it, on a document-bearing camp', () => {
    const db = preV77Db()
    seedCamp(db)
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-swim', 'camp1', 'Swim')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-one', 'camp1', 'Swim')").run()

    initSchema(db) // runs the real v77 migration, arms the real marker

    // docExists: true simulates the case that matters — a camp that has already paired/synced and
    // therefore has a document the backfilled activity_id never reached. shouldRefuseSyncForDomainMigration
    // returns false unconditionally when docExists is false (a brand-new, never-synced camp), so this
    // is the scenario the whole marker exists to protect.
    const refusal = syncRefusalForDomainMigration(db, { docExists: true })
    expect(refusal).not.toBeNull()
    expect(refusal.versions).toContain(77)
    expect(refusal.detail).toContain('77')

    // The inverse: a camp with no document yet is not refused — T268's reader agrees with the
    // startup guard's own docExists gate, not just with the marker's existence.
    expect(syncRefusalForDomainMigration(db, { docExists: false })).toBeNull()
    db.close()
  })
})

describe('migration v77: interrupted-migration idempotence (Red Hat MEDIUM finding)', () => {
  // HONESTY NOTE, stated plainly per the review instructions: this does NOT fork a real OS process
  // and SIGKILL it between the transaction commit and the schema_migrations stamp — that level of
  // interleaving fidelity is impractical inside a synchronous, in-process better-sqlite3 unit test.
  // What it does instead: it reconstructs, BY HAND, the exact database state a real crash in that
  // window would leave — the v77 transaction has fully committed (fixed_events renamed,
  // activity_id backfilled/gapped) but schema_migrations still reports a pre-77 version, because
  // the stamp is a SEPARATE statement after the transaction closes (electron/db/localDb.js, the
  // `db.prepare('INSERT OR IGNORE INTO schema_migrations ...').run(...)` call directly after the
  // `try/finally` block) — then re-invokes the REAL migration code (initSchema) against that exact
  // state, the same way a relaunch after a real crash would. This is weaker than an actual kill-
  // and-restart integration test (it cannot prove nothing ELSE about process-death timing matters,
  // e.g. WAL/journal recovery), but it does exercise the real re-fire path against the real
  // post-crash row shape, not a hand-simulated call to the backfill loop in isolation.
  it('does not duplicate a fixed_event_identity_gaps row or the domain-state marker when the migration re-fires after a crash between the transaction commit and the version stamp', () => {
    const db = preV77Db()
    seedCamp(db)
    // Zero-candidate row (Mifkad) exercises the gap-insert path; this is the row that would
    // duplicate without the deterministic-id fix.
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-zero', 'camp1', 'Mifkad')").run()
    // A real one-candidate row too, so the marker actually arms (backfilledCount > 0) — the crash
    // this test reconstructs must match a genuinely committed transaction, and a transaction that
    // only produced gap rows would not have armed the marker at all (round 4's other fix).
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-swim', 'camp1', 'Swim')").run()
    db.prepare("INSERT INTO anchor_activities (id, camp_id, name) VALUES ('a-one', 'camp1', 'Swim')").run()

    // Reconstruct the post-crash state by hand: run the same rename + activity_id + backfill work
    // the v77 transaction does, using the SAME SQL the real migration uses, then stop — deliberately
    // WITHOUT stamping schema_migrations, exactly like a process killed right after the transaction
    // committed but before the stamp ran.
    db.exec('ALTER TABLE anchor_activities RENAME TO fixed_events')
    db.exec('ALTER TABLE fixed_events ADD COLUMN activity_id TEXT')
    db.prepare("UPDATE fixed_events SET activity_id = 'act-swim' WHERE id = 'a-one'").run()
    // rollbackV77 (used by preV77Db) DROPs fixed_event_identity_gaps entirely, so it must be
    // recreated here — schema.sql's own shape — before the hand-reconstructed gap row can be
    // inserted, matching what schema.sql's CREATE TABLE IF NOT EXISTS would have done at the top
    // of the real migration's initSchema() call.
    db.exec(`
      CREATE TABLE IF NOT EXISTS fixed_event_identity_gaps (
        id TEXT PRIMARY KEY,
        camp_id TEXT NOT NULL REFERENCES camps(id),
        fixed_event_id TEXT NOT NULL,
        name TEXT,
        candidate_count INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('no_match', 'ambiguous'))
      )
    `)
    db.prepare(
      "INSERT OR IGNORE INTO fixed_event_identity_gaps (id, camp_id, fixed_event_id, name, candidate_count, created_at, kind) VALUES ('gap:a-zero', 'camp1', 'a-zero', 'Mifkad', 0, ?, 'no_match')"
    ).run(new Date().toISOString())
    // The domain_state_migration_pending INSERT is the LAST statement INSIDE the same
    // db.transaction() as the rename/backfill work above (electron/db/localDb.js) — a transaction
    // that fully committed would have committed this row too. Hand-inserting it here is what makes
    // this reconstruction match a genuine crash rather than only exercising the gap-row half of the
    // idempotency fix (Red Hat round 4: the crash test previously never armed the marker at all).
    const originalDetail = 'fixed_events.activity_id backfill resolved 1 row(s) and recorded 1 identity gap(s) in fixed_event_identity_gaps — not auto-resolvable (no document-routed remediation exists yet; PR 2+ work)'
    db.prepare(
      `INSERT OR IGNORE INTO domain_state_migration_pending (version, detail, created_at)
       VALUES (77, ?, ?)`
    ).run(originalDetail, new Date().toISOString())
    // schema_migrations is deliberately NOT stamped — getSchemaVersion(db) still reports < 77.
    expect(getSchemaVersion(db)).toBeLessThan(77)
    expect(db.prepare('SELECT COUNT(*) c FROM fixed_event_identity_gaps').get().c).toBe(1)
    expect(db.prepare('SELECT COUNT(*) c FROM domain_state_migration_pending WHERE version = 77').get().c).toBe(1)

    // Between the crash and the relaunch, a sync from another device adds a catalog activity named
    // "Mifkad" — the exact real-world case that turns 'a-zero' from a zero-candidate gap into a
    // one-candidate match. This is what makes the marker-insert code path (backfilledCount > 0)
    // actually execute AGAIN on retry: without this, retry would find backfilledCount === 0 (the
    // only unresolved row, 'a-one', is already resolved from the reconstructed commit) and never
    // attempt the marker write a second time, leaving domain_state_migration_pending's own
    // INSERT OR IGNORE untested — the exact gap Red Hat round 4 found in the original crash test.
    db.prepare("INSERT INTO activities (id, camp_id, name) VALUES ('act-mifkad', 'camp1', 'Mifkad')").run()

    // The "relaunch": the real migration block re-fires because the guard's lower bound (`>= 76`)
    // is still satisfied and the upper bound (`< 77`) still is too — this IS the re-fire this
    // finding is about, not a hand-called helper.
    initSchema(db)

    expect(getSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION)
    // 'a-zero' now resolves to the newly-visible 'act-mifkad' and is backfilled on retry — its
    // ORIGINAL gap row from the reconstructed crash is not deleted (this migration never revisits or
    // cleans up a previously-recorded gap), so exactly one stale gap row remains, unchanged.
    const gapRows = db.prepare('SELECT * FROM fixed_event_identity_gaps WHERE fixed_event_id = ?').all('a-zero')
    expect(gapRows).toHaveLength(1)
    expect(gapRows[0].id).toBe('gap:a-zero')
    expect(db.prepare('SELECT activity_id FROM fixed_events WHERE id = ?').get('a-zero').activity_id).toBe('act-mifkad')
    // The retry's backfill (a-zero -> act-mifkad) makes backfilledCount > 0 AGAIN, so the
    // marker-insert code path actually executes a second time — this is the genuine INSERT OR
    // IGNORE collision Red Hat round 4 found untested: the original crash test never re-armed the
    // marker-write path at all, so a regression here (e.g. an `ON CONFLICT DO UPDATE` swapped in for
    // `OR IGNORE`, or `INSERT` without `OR IGNORE`) would not have been caught. Still exactly one row
    // for version 77, and its `detail` is the ORIGINAL text from the reconstructed crash, not a
    // second insert's different counts (1 row, 0 gaps this time) — proving OR IGNORE actually fired.
    const markerRows = db.prepare('SELECT * FROM domain_state_migration_pending WHERE version = 77').all()
    expect(markerRows).toHaveLength(1)
    expect(markerRows[0].detail).toBe(originalDetail)
    db.close()
  })
})
