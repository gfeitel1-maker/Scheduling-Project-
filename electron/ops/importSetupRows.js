// The atomic setup-import primitive (ADR 2026-09-30-format-agnostic-setup-import.md
// §4.9): apply a confirmed, ordered set of create/update row operations so that
// an unexpected throw mid-set rolls back EVERY op of that import — the database
// is byte-identical to before the import, not "imported N of M".
//
// A drop-in for the future door-swap (part 2 of the ticket): the seven setup
// doors stay on their current hard-stop-and-report loop; this primitive is what
// they will call once part 2 wires them onto it. Nothing is rewired here.
//
// Each row is { action: 'create' | 'update', entity, entity_id, fields, name? }.
// `name` (or fields.name/fields.label/entity_id, in that order) is only used to
// identify the row in a failure report. SKIPs the director already decided in
// preview are the door's business and are filtered out before we are called:
// every row handed to us is a row to write. Only an UNEXPECTED failure aborts.
//
// Atomicity: all row writes happen as direct appendOp calls inside EXACTLY ONE
// runAtomic frame. runAtomic defers the Automerge doc writes and opens the one
// SQLite transaction; an appendOp throw (unregistered field, oversized value,
// orderFieldsForCreate's missing-unique-field throw, a SQLite constraint)
// propagates OUT of the callback, where runAtomic's catch discards the deferred
// doc writes and the SQLite transaction rolls back. We catch it OUTSIDE
// runAtomic only to attach row context — never inside, which would defeat the
// rollback. We open no nested runAtomic and call no op that opens one. (Nested
// inner discards are now frame-accurate regardless — board
// i-nested-discard-leaks-queued-doc-writes made discardDeferredDocWrites
// truncate to its own frame's mark — but this importer's single-frame
// structure does not depend on that.) T309,
// docs/adr/2026-09-29-per-op-savepoint-inside-an-atomic-boundary.md.
//
// Field ordering is guarded at this choke point rather than left to the caller:
// a create goes through orderFieldsForCreate (UNIQUE field + extra scope columns
// to the front — days_of_operation's day_of_week, tiers/time_blocks' cohort_id
// before name), an update through orderFieldsForWrite (fixed_events' kind first),
// so a future door-swap cannot reintroduce the ordering bugs those functions
// exist to prevent (T205, fixed-vs-recurring CHECK). orderFieldsForCreate throws
// when the UNIQUE field is absent on a create — that throw is that row's
// unexpected failure and rolls the set back, same as any other.
import { randomUUID } from 'node:crypto'
import { runAtomic, appendOp } from './operations.js'
import { orderFieldsForCreate, orderFieldsForWrite } from '../../src/data/setupCrudRepository.js'

function rowName(row) {
  return row.name ?? row.fields?.name ?? row.fields?.label ?? row.entity_id
}

// Returns { ok: true, created, updated, rowCount } on a clean commit, or
// { ok: false, failedRow: { number (1-indexed), name, entity, entity_id },
//   reason, created: 0, updated: 0 } when any row's write threw — in which case
// the whole import has rolled back and nothing landed.
export function importSetupRows(db, { rows, author_user_id = null, device_id }) {
  let created = 0
  let updated = 0
  // The row currently being written, captured before each row's writes so the
  // catch below can name the one that threw.
  let current = null

  try {
    runAtomic(db, () => {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        current = { number: i + 1, name: rowName(row), entity: row.entity, entity_id: row.entity_id }
        // A CREATE applies BOTH ordering functions, exactly as the door's
        // createRecord does (orderFieldsForCreate, then writeFields re-applies
        // orderFieldsForWrite): orderFieldsForCreate moves a UNIQUE_FIRST_FIELD
        // (+ scope columns) to the front, and orderFieldsForWrite then moves a
        // REQUIRED_FIRST_ON_WRITE field to the front. The two registries are
        // disjoint, so for any one entity at most one of these moves anything —
        // but applying only orderFieldsForCreate would DROP the kind-first guard
        // for a fixed_events create (fixed_events is in REQUIRED_FIRST_ON_WRITE,
        // not UNIQUE_FIRST_FIELD), leaving its cross-column CHECK (kind before
        // is_all_groups, ADR 2026-08-28) to rest on hand-written field order —
        // the exact per-call-site fragility the registry exists to remove (Red
        // Hat HIGH). An UPDATE applies only orderFieldsForWrite, mirroring
        // writeFields. A malformed action throws and rolls the whole set back.
        if (row.action !== 'create' && row.action !== 'update') {
          throw new Error(`importSetupRows: row ${i + 1} ("${rowName(row)}") has unknown action "${row.action}" — expected 'create' or 'update'`)
        }
        const ordered = row.action === 'create'
          ? orderFieldsForWrite(row.entity, Object.fromEntries(orderFieldsForCreate(row.entity, row.fields)))
          : orderFieldsForWrite(row.entity, row.fields)
        for (const [field, value] of ordered) {
          if (value === undefined) continue
          appendOp(db, {
            entity: row.entity, entity_id: row.entity_id, field, value,
            author_user_id, device_id, client_write_id: randomUUID(), source: 'import',
          })
        }
        if (row.action === 'create') created++
        else updated++
      }
    })
  } catch (err) {
    // The runAtomic frame has already rolled back by the time we get here, so
    // nothing committed: report zero counts and the failed row's context.
    return { ok: false, failedRow: current, reason: err.message, created: 0, updated: 0 }
  }

  return { ok: true, created, updated, rowCount: created + updated }
}
