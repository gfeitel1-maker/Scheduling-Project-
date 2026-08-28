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
// Unlike UNIQUE_FIRST_FIELD above (a programmer-error guard that THROWS if a
// caller gets the order wrong, because getting it wrong there needs a human
// to notice and fix the call site), this is enforced automatically, silently,
// for every caller — a Red Hat review found the FIRST version of this ADR's
// work had gotten the ordering right in two writers (electron/ops/ingest.js,
// AnchorModal.save) and wrong in a third (AnchorsScreen's XLSX import),
// proving per-call-site discipline is not enough. Registering the field here
// means a future writer can't reintroduce the bug by forgetting.
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
    // T9 / Decision B: a UNIQUE_FIRST_FIELD-registered entity MUST write that
    // field first. This is a programmer-error guard, not a user-facing error
    // path — it should never fire given correctly written callers. Writing
    // any other field first can create a permanently orphaned row: if a
    // non-unique field (e.g. capacity) writes first and succeeds, then the
    // unique field collides and is rejected, ensureExists has already
    // materialized a blank-name row nothing will ever finish naming. This
    // guard is the one place `createRecord` is reused by a future call site
    // (the M4 CSV importer) whose field order isn't hand-written the way
    // LocationsScreen.jsx's is — see
    // docs/adr/2026-08-15-locations-concurrent-create-collision.md.
    async createRecord(entity, id, orderedFields) {
      const requiredFirst = UNIQUE_FIRST_FIELD[entity]
      if (requiredFirst && Object.keys(orderedFields)[0] !== requiredFirst) {
        throw new Error(
          `createRecord(${entity}): "${requiredFirst}" must be the first field — got "${Object.keys(orderedFields)[0]}". ` +
          `A create on this entity has an app-level UNIQUE constraint (docs/adr/2026-08-15-locations-concurrent-create-collision.md); ` +
          `writing any other field first can create a permanently orphaned row if the constrained field is later rejected.`
        )
      }
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
