import { localClient } from '../localClient'
import { INGESTIBLE_ENTITIES } from '../ingest/extractEntities'
import { downloadWorkbook } from './exportWorkbook.js'

// Cohort-scoped entities (carry a `cohort_id` column — electron/db/schema.sql)
// among the ones this export fetches. `localClient.list` has no cohort-aware
// counterpart for these three (listByScope's allowlist doesn't cover them —
// electron/main.js SCOPED_LIST_ENTITIES — and adding one is a new electron/ops
// primitive, out of scope here), so the scoping happens client-side instead:
// fetch camp-wide, then keep only the rows for the cohort being exported.
// `groups`/`activities`/`days_of_operation`/`locations`/`cohorts` have no
// cohort_id at all and are left untouched (board q-export-columns-do-not-round-trip, B2b cohort fix a).
const COHORT_SCOPED_ENTITIES = new Set(['tiers', 'time_blocks', 'fixed_events'])

function scopeToCohort(entity, rows, cohortId) {
  if (!COHORT_SCOPED_ENTITIES.has(entity)) return rows
  return rows.filter((row) => row.cohort_id === cohortId)
}

// The S4a enrichment-workbook export, shared by ImportScreen and
// RootsHomeScreen (both offer "Download worksheet"). Read-only: it writes
// nothing to the camp. Throws on failure — callers surface it via
// describeWriteFailure, each in their own error-display idiom.
export async function runWorksheetDownload(cohortId) {
  const camp = await localClient.getCamp().catch(() => null)
  const entities = {}
  for (const entity of INGESTIBLE_ENTITIES) {
    const rows = await localClient.list(entity).catch(() => [])
    entities[entity] = scopeToCohort(entity, rows, cohortId)
  }
  // SLICE B2 (board q-export-columns-do-not-round-trip) — fixed_events is outside
  // INGESTIBLE_ENTITIES (it has no S4b/commitPlan committer, see workbookToSource.js's
  // `screenImportOnly` skip), but exportWorkbook's "Fixed Events" sheet still needs real rows
  // or it ships empty, same as every other entity fetched above.
  entities.fixed_events = scopeToCohort('fixed_events', await localClient.list('fixed_events').catch(() => []), cohortId)
  const base_generation = await localClient.latestOpSeq().catch(() => 0)
  downloadWorkbook({
    ...entities,
    camp_id: camp?.id ?? null,
    cohort_id: cohortId ?? null,
    base_generation,
  })
}
