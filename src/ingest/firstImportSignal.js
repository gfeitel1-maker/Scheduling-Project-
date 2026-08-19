// ADR docs/adr/2026-08-18-roots-reconstruction-moment-gating.md, Gate 3 —
// "first import" for the Roots reconstruction moment is derived from the
// same seven-collection readiness read fetchReadiness() already performs
// (ReconciliationScreen.jsx), not a new ledger/flag. No schema change: this
// is a read the app already does on every reconciliation cycle, factored out
// so ImportScreen can compute it once at parse time (before
// ReconciliationScreen ever mounts) without duplicating the localClient.list
// calls.
import { localClient } from '../localClient'

const FIRST_IMPORT_ENTITIES = [
  'cohorts',
  'tiers',
  'groups',
  'days_of_operation',
  'time_blocks',
  'activities',
  'anchor_activities',
]

export async function fetchFirstImportCollections() {
  const collections = {}
  for (const entity of FIRST_IMPORT_ENTITIES) {
    collections[entity] = await localClient.list(entity).catch(() => [])
  }
  return collections
}

// If every one of these seven collections is empty, no import has ever
// landed structural data for this camp — that IS "first import" for this
// feature (coarser than "has an import ever completed", deliberately; see
// the ADR's Gate 3 note).
export function isFirstImport(collections) {
  return FIRST_IMPORT_ENTITIES.every((entity) => (collections?.[entity]?.length ?? 0) === 0)
}
