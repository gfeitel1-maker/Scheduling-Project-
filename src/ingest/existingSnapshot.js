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

// Roots census roster (Slice 2, docs/adr/2026-08-19-roots-census-and-persistent-
// inspector.md §(a)/(e), R1) — a second, separate live-read fetch. Returns rows
// keyed EXACTLY by the table names CHILD_OF/DOMAIN_OF (domainRollup.js) use,
// unlike ReconciliationScreen's fetchReadiness, which aliases three of these
// keys (days/timeBlocks/anchors) for getReadiness/COLLECTION_FOR's unrelated
// purpose. Deliberately does not touch or alias fetchReadiness's shape —
// buildRootMapModel's roster construction is a literal
// `Object.keys(snapshot).forEach(...)` over CHILD_OF's own keys, so the two
// stay in sync by construction, not by a second table someone has to update.
const CENSUS_ENTITIES = [
  'cohorts', 'tiers', 'groups', 'days_of_operation', 'time_blocks', 'locations', 'activities', 'anchor_activities',
]

// Each entity fetched independently and in parallel (this runs on every
// 250ms-debounced dry-run, not just mount — 8 serial round-trips would be
// wasted latency on every answered decision). A rejected list() call
// resolves to `null`, not `[]` — buildRootMapModel must be able to tell a
// genuinely-empty required table (real not_set_up) apart from a transient
// read failure (e.g. a DB lock during LAN sync), which must never read as
// "nothing set up yet".
//
// Context wiring (Slice 3, ADR docs/adr/2026-08-19-roots-census-and-
// persistent-inspector.md §(e)/(g)) — two more calls, kept OUTSIDE
// CENSUS_ENTITIES/CHILD_OF on purpose: Context has no CHILD_OF/DOMAIN_OF
// entry (by design, guarded by domainRollup.test.js) and never will, so these
// two keys ('field_trips', 'day_overrides') are not part of the
// CHILD_OF-reverse-grouping loop rootMapModel.js runs over Object.keys of the
// other eight. The PRESET_STAMPS list is duplicated (not imported) from
// src/components/schedule/FieldTripDrawer.jsx — that file is a React
// component and unexported constant; this module must stay importable
// outside React/jsdom, and the value is a small, stable, camp-culture
// vocabulary, not something that drifts silently.
const FIELD_TRIP_PRESET_LABELS = new Set(['Field Trip', 'Special Event', 'Service Project'])

export async function fetchCensusSnapshot(list) {
  const entries = await Promise.all(CENSUS_ENTITIES.map(async (entity) => {
    const nameCol = NAME_COLUMN[entity] ?? 'name'
    let rows
    try { rows = (await list(entity)) ?? [] } catch { rows = null }
    return [entity, rows ? rows.map((r) => ({ ...r, name: r[nameCol] })) : null]
  }))
  const snapshot = Object.fromEntries(entries)

  const [overlays, dayOverrides, templates] = await Promise.all([
    (async () => { try { return (await list('template_overlays')) ?? [] } catch { return null } })(),
    (async () => { try { return (await list('day_override_templates')) ?? [] } catch { return null } })(),
    (async () => { try { return (await list('schedule_templates')) ?? [] } catch { return null } })(),
  ])

  const dayNameById = new Map((snapshot.days_of_operation ?? []).map((d) => [d.id, d.name]))
  // template_id -> which of the two schedule routes it belongs to, so a
  // Field Trip roster row deep-links to the exact route it was stamped on,
  // not a fixed per-child guess. A template whose kind can't be resolved
  // (fetch failure, or a stray template_id) degrades to 'schedule:manual' —
  // read-only navigation, never a write, so a wrong-route guess costs a
  // click, not data.
  const routeByTemplateId = new Map(
    (templates ?? []).map((t) => [t.id, t.kind === 'manual' ? 'schedule:manual' : 'schedule:generated']),
  )

  snapshot.field_trips = overlays === null ? null : overlays
    .filter((row) => FIELD_TRIP_PRESET_LABELS.has(row.label))
    .map((row) => {
      const dayName = row.day_id != null ? dayNameById.get(row.day_id) : null
      return {
        id: row.id,
        name: dayName ? `${row.label} — ${dayName}` : row.label,
        route: routeByTemplateId.get(row.template_id) ?? 'schedule:manual',
      }
    })

  snapshot.day_overrides = dayOverrides === null ? null : dayOverrides.map((row) => ({ id: row.id, name: row.name }))

  return snapshot
}
