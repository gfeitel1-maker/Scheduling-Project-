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
  const base_generation = await localClient.latestOpSeq().catch(() => 0)
  downloadWorkbook({
    ...entities,
    camp_id: camp?.id ?? null,
    cohort_id: cohortId ?? null,
    base_generation,
  })
}
