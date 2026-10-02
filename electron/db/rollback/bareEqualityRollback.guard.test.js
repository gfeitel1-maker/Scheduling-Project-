// GUARD (T220): every rollback in electron/db/rollback/ must delete
// `schema_migrations` rows with `WHERE version >= N`, never `WHERE version = N`.
//
// A bare equality strands any HIGHER version row: rolling back vN on a db that has
// since migrated to vN+1 leaves getSchemaVersion() reporting N+1 while vN's tables
// are gone — a shape no migration path can produce and none will repair. This
// exact defect shipped in 20 rollback files (v24 through v68) under a green suite
// because the paired test (e.g. v68_down.test.js:46, asserting
// `WHERE version = 68` is 0 after rollback) is TRUE regardless of whether the
// production code says `=` or `>=` — it tests an adjacent fact, not this one. See
// docs/work/tickets/T216-gate-semantics-write-up.md for that class of finding, and
// docs/work/tickets/T220-<slug>.md for this ticket.
//
// Scoped to non-test files: *_down.test.js files legitimately assert
// `WHERE version = N` (checking the row for N specifically is gone), which is a
// different, correct claim — see v68_down.test.js:46 and the equivalent in
// v66_down.test.js. Scanning only `*_down.js` (not `*.test.js`) avoids that
// false positive by construction.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('rollback bare-equality schema_migrations guard', () => {
  const files = readdirSync(__dirname)
    .filter((name) => /^v\d+_down\.js$/.test(name))
    .map((name) => join(__dirname, name))

  it('found a non-empty, expected-size set of rollback files to scan', () => {
    // Guards against a disarmed-quiet guard: if the glob broke and matched
    // nothing, the shape assertion below would vacuously pass every file (of
    // which there are zero). Assert the count explicitly so a future rollback
    // file changes this number and forces a look, rather than silently
    // enlarging or shrinking what's covered.
    // 41 as of v81_down.js (T312). Looked, as this tripwire demands, rather than
    // just re-counting: v81_down.js deletes with `WHERE version >= 81`, so it
    // satisfies the guard below on its own merits. It is also the first rollback
    // whose entity REPLICATES, so it drops only this device's projection and says
    // so in its own header — a peer still on v81 keeps its rows and re-sends them.
    //
    // 38 as of v78_down.js (T265). Looked, as this tripwire demands, rather than
    // just re-counting: v78_down.js deletes with `WHERE version >= 78`, so it
    // satisfies the guard below on its own merits — and it REFUSES rather than
    // collapsing when a (run_id, camper_id, choice_id) spans more than one
    // occurrence, naming the blocking rows.
    //
    // 37 was v77_down.js (T267). Deletes with `WHERE version >= 77`, so it
    // satisfies the guard on its own merits — it reverses the
    // anchor_activities -> fixed_events rename and drops activity_id/
    // fixed_event_identity_gaps, losing only a name-match resolution that
    // re-derives identically from the same catalog state on re-migration.
    //
    // 36 was v76_down.js (T197). v76_down.js deletes with `WHERE version >= 76`,
    // so it satisfies the guard below on its own merits — and the four columns
    // it drops (cell_kind, choice_id, is_linked_choice, choice_label) are all
    // derivable again by re-finalizing the run, so the rollback loses a
    // denormalized projection rather than any camp data.
    //
    // 35 was v75_down.js (T266): deletes with `WHERE version >= 75`, drops a
    // nullable column only ingest writes, so it loses a classification.
    //
    // 39 is v79_down.js (T279). Deletes with `WHERE version >= 79`, and drops
    // two nullable columns: elective_preferences.rank_kind, re-derivable by
    // re-importing, and campers.division_label, which is NOT — it is provenance
    // no other row records, so that value is gone until the source file is
    // imported again. The rollback says so rather than implying reversibility.
    //
    // 40 is v80_down.js (T265). Deletes with `WHERE version >= 80`, and drops the
    // two minimum-headcount columns on elective_set_activities. What it loses is
    // a CONSTRAINT rather than a derivable value: after the rollback an offering
    // below its minimum runs again and nothing says so, and any minimum a
    // director set must be set again. The rollback says that rather than implying
    // reversibility.
    //
    // 42 is v82_down.js (T312). Deletes with `WHERE version >= 82`, so it
    // satisfies the guard below on its own merits. Its entity REPLICATES, so the
    // drop removes only this device's projection and its header says so — a peer
    // still on v82 keeps its rows and re-sends them.
    //
    // 41 is v81_down.js (T301). Deletes with `WHERE version >= 81`, and drops the
    // three linked-elective-bundle tables outright (elective_bundles,
    // elective_bundle_periods, elective_bundle_tiers). There is no prior state to
    // restore — none of these tables existed before v81 — so every authored
    // bundle is discarded, and the rollback says so rather than implying
    // reversibility.
    //
    // 43 is v83_down.js (T320). Deletes with `WHERE version >= 83`, so it
    // satisfies the guard below on its own merits. It drops elective_run_findings
    // outright and leaves the two new elective_assignment_runs columns
    // (snapshot_expected_rows, snapshot_digest) in place rather than recreating a
    // large, heavily-registered, replicated table — its entity REPLICATES, so the
    // drop removes only this device's projection of the findings, not the peer
    // copies.
    //
    // 44 is v72_down.js (T269, sweeps PR E). Deletes with `WHERE version >= 72`, so
    // it satisfies the guard below on its own merits. It is the first module in
    // this directory that drops NOTHING, because the forward migration it inverts
    // (v72, T233) only ever stamped a `schema_migrations` version row — the
    // `tombstones` table it names is created unconditionally by schema.sql on
    // every open, not by this migration, so there was never anything for the
    // rollback to undo beyond the marker itself.
    //
    // 45 is v84_down.js (T293, anchors-become-fixed-and-recurring-events), added after this
    // count was last pinned.
    //
    // 46 is v85_down.js (T321, camper-id-high-entropy-format).
    //
    // 47 is v86_down.js (T322 S3a, peer_tombstone_reports).
    expect(
      files.length,
      'a new electron/db/rollback/vNN_down.js landed — bump this literal and add a dated ' +
        'one-line note above it (like the v84/v85/v86 notes) saying which vNN it is'
    ).toBe(47)
  })

  it('every rollback file uses `>= N`, never bare `= N`, to delete its schema_migrations row', () => {
    const offenders = []
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      const match = src.match(/DELETE FROM schema_migrations WHERE version\s*(=|>=)\s*(\d+)/)
      if (!match) {
        offenders.push(`${file.slice(__dirname.length + 1)}: no schema_migrations DELETE found`)
        continue
      }
      if (match[1] !== '>=') {
        offenders.push(`${file.slice(__dirname.length + 1)}: uses '${match[1]} ${match[2]}', must be '>= ${match[2]}'`)
      }
    }
    expect(offenders, offenders.join('; ')).toEqual([])
  })
})
