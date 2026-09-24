// The shared persistence seam for the five setup-CRUD screens (Groups, Tiers,
// Days, TimeBlocks, Activities). ADR 2026-08-12.
//
// It owns: the field-level write loop, atomic create-with-cleanup, and
// delete-all-with-role-tallying — the three pieces measured as byte-similar
// duplication across the five screens.
//
// It does NOT own: row-shape validation, error copy, XLSX parsing, or any
// React state. It returns data / throws the original error; the caller (the
// hook, or a screen directly) decides what to show.
//
// Collaborators are injected (mirrors src/data/scheduleRepository.js) so the
// seam is the test surface: a test drives it with a fake localClient, no
// React, no Electron.
//
// T9 (docs/adr/2026-08-15-locations-concurrent-create-collision.md addendum,
// Decision B): the renderer-side half of electron/ops/operations.js's
// UNIQUE_FIELD_ENTITIES — not imported directly, since that module pulls in
// better-sqlite3/node:crypto and cannot cross into the renderer bundle — so
// this is a verbatim transcription, kept honest by
// electron/uniqueFirstFieldRegistryParity.test.js, which imports BOTH
// modules under Vitest (same runner, no bundler involved) and fails if a key
// is added to one registry without the other, the same duplication
// discipline MOCK_WRITE_ALLOWLIST (src/localClient.mock.js) already uses
// against electron/ops/projections.js.
export const UNIQUE_FIRST_FIELD = {
  locations: 'name',
  elective_sets: 'name',
  events: 'name',
  activities: 'name',
  // days_of_operation has UNIQUE(camp_id, day_of_week) as of T205 — see
  // electron/ops/operations.js's UNIQUE_FIELD_ENTITIES entry.
  days_of_operation: 'day_of_week',
  // T238 (docs/work/tickets/T238-unique-field-registry-covers-all-ten.md):
  // the six relaxed-in-v73 entities newly registered in
  // electron/ops/operations.js's UNIQUE_FIELD_ENTITIES. Required here too —
  // electron/uniqueFirstFieldRegistryParity.test.js hard-fails otherwise.
  groups: 'name',
  cohorts: 'name',
  tiers: 'name',
  time_blocks: 'name',
  schedule_weeks: 'name',
  special_days: 'name',
}

// T238: extra (non-camp) scope columns that must be written BEFORE the
// UNIQUE_FIRST_FIELD field itself on a create, so
// electron/ops/operations.js's detectUniqueFieldCollision can read their
// current value off the row when it checks the unique field's write — see
// that module's UNIQUE_FIELD_EXTRA_SCOPE_COLUMNS (this is the src/-side
// transcription; electron/ can't be imported from src/, same reason
// UNIQUE_FIRST_FIELD above transcribes UNIQUE_FIELD_ENTITIES's `field`).
// `tiers`/`time_blocks` are UNIQUE(camp_id, cohort_id, name): without this,
// a create writes `name` first (per orderFieldsForCreate below) while
// `cohort_id` is still unset, so the collision check would have no scope
// value to read and would silently skip itself on every create.
export const UNIQUE_FIELD_EXTRA_SCOPE_COLUMNS = {
  tiers: ['cohort_id'],
  time_blocks: ['cohort_id'],
}

// Fixed vs Recurring events (docs/adr/2026-08-28-fixed-vs-recurring-events.md
// §3): anchor_activities has a cross-column CHECK (`kind='fixed' requires
// is_all_groups=1, unit_id/group_ids empty`) evaluated after EVERY
// single-field UPDATE, since writeFields below fires one op-log write per
// field. A fresh row's ensureExists stub defaults kind='fixed',
// is_all_groups=1 — narrowing it to Recurring (is_all_groups=false/
// group_ids set) while `kind` is still 'fixed' violates the CHECK on that
// UPDATE, even though the SAME field set narrows correctly once `kind` is
// applied first.
//
// Like UNIQUE_FIRST_FIELD above (which, since the 2026-09-18 reversal, also
// auto-reorders its field to the front rather than throwing on misorder), this
// is enforced automatically, silently, for every caller — a Red Hat review
// found the FIRST version of this ADR's work had gotten the ordering right in
// two writers (electron/ops/ingest.js, AnchorModal.save) and wrong in a third
// (AnchorsScreen's XLSX import), proving per-call-site discipline is not
// enough. Registering the field here means a future writer can't reintroduce
// the bug by forgetting. The one behavioral difference from UNIQUE_FIRST_FIELD:
// this reorder is a no-op when the field is absent from a write (an edit that
// only touches `notes` legitimately omits `kind`), whereas a create MUST carry
// its UNIQUE_FIRST_FIELD field, so orderFieldsForCreate throws on absence.
//
// COMPOSITION: these two registries MUST stay disjoint. createRecord applies
// orderFieldsForCreate (UNIQUE_FIRST_FIELD → front) first, then writeFields
// applies orderFieldsForWrite (REQUIRED_FIRST_ON_WRITE → front) second and
// unconditionally — so if an entity were ever registered in BOTH, the
// REQUIRED_FIRST_ON_WRITE field would silently win position 0, displacing the
// collision-guarded field. No entity is in both today (anchor_activities only
// here); if one ever needs both, that priority conflict is a Governor-level
// decision (unique-field safety vs. cross-column CHECK safety), not a silent
// last-writer-wins default.
export const REQUIRED_FIRST_ON_WRITE = {
  anchor_activities: 'kind',
}

// Returns `fields`' entries as [field, value] pairs, with the entity's
// REQUIRED_FIRST_ON_WRITE field (if registered and present) moved to the
// front. A no-op for an unregistered entity, or when the field isn't present
// in this particular write (e.g. a write that only touches `notes`). Exported
// so a test can assert the reordering directly, independent of the write loop.
export function orderFieldsForWrite(entity, fields) {
  const requiredFirst = REQUIRED_FIRST_ON_WRITE[entity]
  const entries = Object.entries(fields)
  if (!requiredFirst || !(requiredFirst in fields)) return entries
  const first = entries.find(([field]) => field === requiredFirst)
  const rest = entries.filter(([field]) => field !== requiredFirst)
  return [first, ...rest]
}

// Returns `fields`' entries as [field, value] pairs, with the entity's
// UNIQUE_FIRST_FIELD field moved to the front — mirrors orderFieldsForWrite/
// REQUIRED_FIRST_ON_WRITE above, applied to the same lesson that guard encodes:
// a future writer must not be able to reintroduce T205's bug by building the
// create object in the wrong order. Throws ONLY when the registered field is
// ABSENT — a create that never emits the unique field is genuinely
// unprotectable (no op ever reaches detectUniqueFieldCollision for it; for
// days_of_operation the same-weekday collision then lands on ensureExists's
// INSERT OR IGNORE and is silently dropped).
export function orderFieldsForCreate(entity, fields) {
  const uniqueFirst = UNIQUE_FIRST_FIELD[entity]
  if (!uniqueFirst) return Object.entries(fields)
  if (!(uniqueFirst in fields)) {
    throw new Error(
      `createRecord(${entity}): must include "${uniqueFirst}" — a create on this entity has an ` +
      `app-level UNIQUE constraint (docs/adr/2026-08-15-locations-concurrent-create-collision.md); ` +
      `a create that never writes this field leaves the row permanently unprotected against a ` +
      `same-value collision.`
    )
  }
  // T238: extra scope columns (present) go BEFORE the unique field itself,
  // so a composite-scope entity's collision check (electron/ops/operations.js's
  // detectUniqueFieldCollision) can read their value off the row by the time
  // the unique field's own write lands. A missing extra scope column is left
  // in place — that create is unprotectable for composite scope the same way
  // an absent uniqueFirst field would be, but it is not this function's job
  // to invent a value that was never provided.
  const extraScopeColumns = (UNIQUE_FIELD_EXTRA_SCOPE_COLUMNS[entity] || []).filter((col) => col in fields)
  const entries = Object.entries(fields)
  const scopeFirst = extraScopeColumns.map((col) => entries.find(([field]) => field === col))
  const uniqueFirstEntry = entries.find(([field]) => field === uniqueFirst)
  const rest = entries.filter(([field]) => field !== uniqueFirst && !extraScopeColumns.includes(field))
  return [...scopeFirst, uniqueFirstEntry, ...rest]
}

export function createSetupCrudRepository({
  localClient,
  getToken = () => localStorage.getItem('shoresh-token'),
}) {
  // Fires one write() per field (the op-log is field-level) and surfaces the
  // first failure rather than a silent partial write. Field order is
  // preserved from the caller's object, EXCEPT for an entity registered in
  // REQUIRED_FIRST_ON_WRITE above: that field (when present) is always moved
  // to the front, regardless of the order the caller built its object in.
  async function writeFields(entity, id, fields) {
    const token = getToken()
    const orderedEntries = orderFieldsForWrite(entity, fields)
    for (const [field, value] of orderedEntries) {
      const result = await localClient.write(token, entity, id, field, value)
      if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
        throw new Error(`write failed for field "${field}"`)
      }
    }
  }

  return {
    writeFields,

    // Writes orderedFields in the given order. On any failure, best-effort
    // deletes the partially-created row (a field write earlier in the order —
    // typically `name` — may already have created it via ensureExists), then
    // rethrows the ORIGINAL error, never a cleanup error.
    //
    // T9 / Decision B (reversed 2026-09-18, see the ADR's "Reversal" section):
    // a UNIQUE_FIRST_FIELD-registered entity's field is now auto-reordered to
    // the front rather than requiring the caller to have built it first — a
    // future writer (e.g. the M4 CSV importer) whose field order isn't
    // hand-written the way LocationsScreen.jsx's is can no longer reintroduce
    // T205's bug by getting the order wrong, because there is no wrong order
    // to get: orderFieldsForCreate fixes it up. It still throws when the
    // registered field is ABSENT — that create is genuinely unprotectable —
    // see docs/adr/2026-08-15-locations-concurrent-create-collision.md.
    async createRecord(entity, id, fields) {
      const orderedFields = Object.fromEntries(orderFieldsForCreate(entity, fields))
      try {
        await writeFields(entity, id, orderedFields)
      } catch (err) {
        try {
          await localClient.deleteEntity(getToken(), entity, id)
        } catch {
          // best-effort only — must not mask the original error
        }
        throw err
      }
    },

    // Loops deleteEntity over the given ids. Caller re-fetches fresh ids
    // before calling this — the repository does not own "what counts as this
    // camp's rows" (that varies: camp_id only for Groups, camp_id+cohort_id
    // for Tiers, etc).
    async deleteAllRecords(entity, ids) {
      const token = getToken()
      let succeeded = 0
      let failedDueToRole = false
      for (const id of ids) {
        try {
          const result = await localClient.deleteEntity(token, entity, id)
          if (result && (result.status === 'applied' || result.status === 'queued')) {
            succeeded++
          } else {
            console.error(`Failed to delete ${entity} ${id}`)
          }
        } catch (err) {
          if (/admin role required/i.test(err?.message ?? '')) failedDueToRole = true
          console.error(`Failed to delete ${entity} ${id}`, err)
        }
      }
      return { succeeded, failed: ids.length - succeeded, failedDueToRole }
    },
  }
}
