import { localClient } from '../localClient'
import { INGESTIBLE_ENTITIES } from '../ingest/extractEntities'
import { downloadWorkbook } from './exportWorkbook.js'

// The S4a enrichment-workbook export, shared by ImportScreen and
// RootsHomeScreen (both offer "Download worksheet"). Read-only: it writes
// nothing to the camp. Throws on failure — callers surface it via
// describeWriteFailure, each in their own error-display idiom.
export async function runWorksheetDownload(cohortId) {
  const camp = await localClient.getCamp().catch(() => null)
  const entities = {}
  for (const entity of INGESTIBLE_ENTITIES) {
    entities[entity] = await localClient.list(entity).catch(() => [])
  }
  // SLICE B2 (board q-export-columns-do-not-round-trip) — fixed_events is outside
  // INGESTIBLE_ENTITIES (it has no S4b/commitPlan committer, see workbookToSource.js's
  // `screenImportOnly` skip), but exportWorkbook's "Fixed Events" sheet still needs real rows
  // or it ships empty, same as every other entity fetched above.
  entities.fixed_events = await localClient.list('fixed_events').catch(() => [])
  const base_generation = await localClient.latestOpSeq().catch(() => 0)
  downloadWorkbook({
    ...entities,
    camp_id: camp?.id ?? null,
    cohort_id: cohortId ?? null,
    base_generation,
  })
}
