// S5b — the renderer-side dry-run snapshot buildPlan diffs against BEFORE commit.
//
// This mirrors electron/ops/ingest.js's buildExistingSnapshot exactly, but reads
// through localClient.list instead of SQL, so the ledger's preview and the atomic
// commit classify every row the same way (create/update/unchanged/clear/conflict).
// commitIngest re-runs buildPlan against its own live snapshot at commit time
// (Article V), so this is a faithful preview, never the source of truth.
//
// Kept pure over an injected `list` fn (no localClient import) so it is testable
// without React or IPC, and cannot drift from the committer's shape: same
// cohort-scoping (tiers/time_blocks to the active Program), same FK label
// enrichment via the SHARED enrichSnapshotRow.

import { INGESTIBLE_ENTITIES } from './extractEntities.js'
import { enrichSnapshotRow } from './fieldUpdate.js'

const COHORT_SCOPED = new Set(['tiers', 'time_blocks'])
// days_of_operation stores its name as `label`; the committer selects it AS name
// so normalizeName sees it. Mirror that here.
const NAME_COLUMN = { days_of_operation: 'label' }

// M4 §D2 mirror (electron/ops/ingest.js's ALWAYS_SCANNED_ENTITIES): locations
// is durable camp infrastructure, scanned live in every mode, unlike the six
// schedule-content entities the previous `mode === 'replace' ? null : ...`
// ternary skipped entirely in replace mode — see the call site's own comment.
const ALWAYS_SCANNED_ENTITIES = ['locations']

export async function buildExistingSnapshot(list, cohortId, mode = 'add') {
  const safeList = async (entity) => {
    try { return (await list(entity)) ?? [] } catch { return [] }
  }

  // Live id->name maps so the snapshot can carry FK fields in the LABEL form
  // buildPlan compares against (it holds no DB handle and cannot resolve).
  const groupNameById = new Map()
  for (const r of await safeList('groups')) groupNameById.set(r.id, r.name)
  const tierNameById = new Map()
  for (const r of await safeList('tiers')) tierNameById.set(r.id, r.name)
  // M4 §D4: locations' own id->name map, mirroring tierNameById/groupNameById
  // — without it every activity's location_name would read null here, and
  // buildPlan would diff a re-import's proposal as an "update" even when the
  // location is unchanged.
  const locationNameById = new Map()
  for (const r of await safeList('locations')) locationNameById.set(r.id, r.name)

  const entitiesToScan = mode === 'replace' ? ALWAYS_SCANNED_ENTITIES : INGESTIBLE_ENTITIES
  const existing = {}
  for (const entity of entitiesToScan) {
    const nameCol = NAME_COLUMN[entity] ?? 'name'
    const rows = (await safeList(entity)).map((r) => ({ ...r, name: r[nameCol] }))
    const scoped = COHORT_SCOPED.has(entity) && cohortId
      ? rows.filter((r) => r.cohort_id === cohortId)
      : rows
    for (const row of scoped) enrichSnapshotRow(entity, row, groupNameById, tierNameById, locationNameById)
    existing[entity] = scoped
  }
  return existing
}
