// Commit an approved import proposal, or commit nothing.
//
// docs/adr/2026-08-01-ingesting-a-prior-year-schedule.md §2, §4.
//
// Two guarantees, both of them the point of this file:
//
//   • **Whitelist.** Only the six setup entities can be created here. The
//     placements are sitting right there in the parsed grid, and "entities
//     only" is a scope decision that will come under pressure; a whitelist is
//     the difference between reopening it deliberately and doing it by
//     accident.
//
//   • **All or nothing.** The whole import runs in one SQLite transaction. A
//     partial ingest that half-populates a camp is worse than one that fails
//     cleanly — T16 — and better-sqlite3's transaction gives that for free
//     provided every write goes through this one function.

import { randomUUID } from 'node:crypto'
import { appendOp } from './operations.js'

// ADR §2. Kept here rather than imported from the renderer so the guarantee
// lives with the code that writes; ingest.test.js asserts the two agree.
export const INGESTIBLE_ENTITIES = Object.freeze([
  'cohorts', 'tiers', 'groups', 'days_of_operation', 'time_blocks', 'activities',
])

const DAY_INDEX = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
}

// "08:40–09:00" / "9:15-9:40" -> { start_time, end_time }. Returns nulls when
// the label is not a range, which is normal — a period may be named "Block 2".
function parseTimeRange(label) {
  const match = String(label ?? '').match(/(\d{1,2})[:.](\d{2})\s*[-–—]\s*(\d{1,2})[:.](\d{2})/)
  if (!match) return { start_time: null, end_time: null }
  const pad = (h, m) => `${String(h).padStart(2, '0')}:${m}`
  return { start_time: pad(match[1], match[2]), end_time: pad(match[3], match[4]) }
}

// The fields each entity needs beyond its name, derived rather than guessed.
// A director approved a list of names; they did not approve a day-of-week
// number, so it is computed from the name and nothing else is invented.
function fieldsFor(entity, name, campId, index) {
  switch (entity) {
    case 'cohorts':
      return { camp_id: campId, name }
    case 'tiers':
      return { camp_id: campId, name, sort_order: index }
    case 'groups':
      return { camp_id: campId, name, availability: 'all' }
    case 'days_of_operation': {
      const dow = DAY_INDEX[String(name).trim().toLowerCase()]
      return {
        camp_id: campId,
        label: name,
        day_of_week: dow ?? index,
        sort_order: dow ?? index,
      }
    }
    case 'time_blocks': {
      const { start_time, end_time } = parseTimeRange(name)
      return { camp_id: campId, name, start_time, end_time, sort_order: index }
    }
    case 'activities':
      return { camp_id: campId, name }
    default:
      // Unreachable — commitIngest rejects before this point. Kept as a second
      // gate so a future caller cannot slip past by adding a case above.
      throw new Error(`ingest: ${entity} is not an ingestible entity`)
  }
}

/**
 * Create the approved records, all together or not at all.
 *
 * `approved` is `{ [entity]: [name, ...] }` — exactly what the director
 * confirmed in the preview, not the raw proposal. Anything outside
 * INGESTIBLE_ENTITIES is a hard error rather than a silent skip: a caller
 * asking to ingest placements has misunderstood something, and quietly
 * dropping the request would hide that.
 *
 * Returns `{ created: { [entity]: count }, total }`.
 */
export function commitIngest(db, { approved, camp_id, author_user_id, device_id }) {
  if (!approved || typeof approved !== 'object') throw new Error('ingest: nothing to commit')
  if (!camp_id) throw new Error('ingest: camp_id is required')

  for (const entity of Object.keys(approved)) {
    if (!INGESTIBLE_ENTITIES.includes(entity)) {
      throw new Error(`ingest: ${entity} cannot be created by an import`)
    }
  }

  const created = {}
  let total = 0

  // One transaction for the whole import. Any throw below — a constraint, a
  // bad field, a disk error — rolls back every op and every projected row
  // together, so the camp is either fully imported or untouched.
  const run = db.transaction(() => {
    for (const entity of INGESTIBLE_ENTITIES) {
      const names = Array.isArray(approved[entity]) ? approved[entity] : []
      created[entity] = 0
      names.forEach((rawName, index) => {
        const name = String(rawName ?? '').trim()
        if (!name) return
        const entityId = randomUUID()
        for (const [field, value] of Object.entries(fieldsFor(entity, name, camp_id, index))) {
          if (value === null || value === undefined) continue
          appendOp(db, {
            entity,
            entity_id: entityId,
            field,
            value,
            author_user_id: author_user_id ?? null,
            device_id,
            parent_op_id: null,
            client_write_id: randomUUID(),
          })
        }
        created[entity] += 1
        total += 1
      })
    }
  })

  run()
  return { created, total }
}
