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
export const UNIQUE_FIRST_FIELD = { locations: 'name', elective_sets: 'name' }

export function createSetupCrudRepository({
  localClient,
  getToken = () => localStorage.getItem('shoresh-token'),
}) {
  // Fires one write() per field (the op-log is field-level) and surfaces the
  // first failure rather than a silent partial write. Field order is
  // preserved from the caller's object.
  async function writeFields(entity, id, fields) {
    const token = getToken()
    for (const [field, value] of Object.entries(fields)) {
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
