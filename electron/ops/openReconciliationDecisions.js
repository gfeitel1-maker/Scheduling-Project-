// Host-local journal of still-unresolved reconciliation decisions.
// docs/adr/2026-08-28-persisted-reconciliation-decisions.md
//
// Modeled on electron/ops/migrationReviews.js: listX/dismissX, table-absence
// guarded so a device that paired in after the v52 migration ran elsewhere
// never throws. The write step (replaceOpenDecisionsForCommit) is called
// from commitPlan (electron/ops/ingest.js) inside its own commit transaction
// — this module owns no db.transaction() of its own for that reason.
import { domainOf, childOf } from '../../src/components/reconciliation/domainRollup.js'

// Duplicated from electron/ops/ingest.js's COHORT_SCOPED rather than
// imported, to avoid a circular import (ingest.js's commitPlan calls
// replaceOpenDecisionsForCommit below). Same precedent as
// src/screens/importAliasScope.js's ALIAS_COHORT_SCOPED /
// src/localClient.mock.js's MOCK_COHORT_SCOPED — held honest by
// openReconciliationDecisions.cohortScopedDrift.test.js.
const COHORT_SCOPED = new Set(['tiers', 'time_blocks'])

function hasTable(db) {
  return !!db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'open_reconciliation_decisions'")
    .get()
}

export function listOpenReconciliationDecisions(db, campId) {
  if (!hasTable(db)) return []
  if (!campId) return []
  return db
    .prepare(
      `SELECT id, camp_id, entity_type, cohort_id, entity_id, identity_key, kind,
              domain_key, child_key, entity_name, reason, import_run_id, created_at
         FROM open_reconciliation_decisions WHERE camp_id = ? ORDER BY created_at ASC`
    )
    .all(campId)
}

// Dismiss = a plain DELETE ... WHERE id = ?, unconditionally — no join to
// entity liveness, so it always works even for a row whose underlying
// entity no longer exists (§4c's "never a dead end" guarantee).
export function dismissOpenReconciliationDecisions(db, ids) {
  if (!hasTable(db)) return { ok: true, dismissed: 0 }
  if (!Array.isArray(ids) || ids.length === 0) return { ok: true, dismissed: 0 }

  const stmt = db.prepare('DELETE FROM open_reconciliation_decisions WHERE id = ?')
  const run = db.transaction((idList) => {
    let dismissed = 0
    for (const id of idList) {
      if (typeof id !== 'string' || id.length === 0) continue
      dismissed += stmt.run(id).changes
    }
    return dismissed
  })

  return { ok: true, dismissed: run(ids) }
}

// The write step §3/§4 calls from inside commitPlan's own transaction.
// `decisions` is a flat array of { id, entity, entityId, entityName, kind,
// reason, field } — the same shape reconciliationReport.js's decisionId/
// fixedEventDecisionId-keyed decisions carry (kind is confirm_value or
// confirm_change; held conflicts are out of scope — ADR §1a). Every decision
// in one commit shares the SAME cohortId (a single per-commit parameter, not
// per-entity).
//
// Scoped delete-and-replace (§4a/§4c, Finding 2): only the (entity_type,
// cohort_id) scopes this commit's decisions actually touch are cleared —
// an entity_type/cohort this commit never looked at is left untouched
// (amnesty-by-omission fix). Uses `cohort_id IS ?`, not `= ?`, so a
// cohort-scoped row with cohort_id = NULL is still matched (Fix 2).
// `touchedEntityTypes` (optional) names every entity_type this commit's
// plan actually considered, even one that produced zero open decisions —
// without it, a commit that fully resolves a type's last open decision
// would leave a stale row behind (that type's `decisions` array is empty,
// so the type never appears in `decisions` and its scope is never
// visited). Defaults to the entity types present in `decisions` for
// backward-compatible direct calls (e.g. tests) that don't care about the
// all-resolved case.
export function replaceOpenDecisionsForCommit(db, { campId, decisions, touchedEntityTypes = null, cohortId = null, importRunId, createdAt }) {
  if (!hasTable(db)) return
  if (!campId) return

  const byType = new Map()
  for (const d of decisions ?? []) {
    if (!byType.has(d.entity)) byType.set(d.entity, [])
    byType.get(d.entity).push(d)
  }
  const touched = touchedEntityTypes ?? [...byType.keys()]
  for (const entityType of touched) {
    if (!byType.has(entityType)) byType.set(entityType, [])
  }

  const deleteScoped = db.prepare(
    'DELETE FROM open_reconciliation_decisions WHERE camp_id = ? AND entity_type = ? AND cohort_id IS ?'
  )
  const deleteUnscoped = db.prepare(
    'DELETE FROM open_reconciliation_decisions WHERE camp_id = ? AND entity_type = ?'
  )
  const insert = db.prepare(
    `INSERT INTO open_reconciliation_decisions
       (id, camp_id, entity_type, cohort_id, entity_id, identity_key, kind, domain_key, child_key,
        entity_name, reason, import_run_id, created_at)
     VALUES (@id, @camp_id, @entity_type, @cohort_id, @entity_id, @identity_key, @kind, @domain_key, @child_key,
             @entity_name, @reason, @import_run_id, @created_at)
     ON CONFLICT(id) DO UPDATE SET
       cohort_id = excluded.cohort_id, entity_id = excluded.entity_id,
       identity_key = excluded.identity_key, kind = excluded.kind,
       domain_key = excluded.domain_key, child_key = excluded.child_key,
       entity_name = excluded.entity_name, reason = excluded.reason,
       import_run_id = excluded.import_run_id, created_at = excluded.created_at`
  )

  for (const [entityType, typeDecisions] of byType) {
    const scoped = COHORT_SCOPED.has(entityType)
    if (scoped) deleteScoped.run(campId, entityType, cohortId ?? null)
    else deleteUnscoped.run(campId, entityType)

    for (const d of typeDecisions) {
      const entityId = d.entityId ?? null
      const identityKey = entityId ?? d.identityKey ?? d.id
      insert.run({
        id: d.id,
        camp_id: campId,
        entity_type: entityType,
        cohort_id: scoped ? (cohortId ?? null) : null,
        entity_id: entityId,
        identity_key: identityKey,
        kind: d.kind,
        domain_key: domainOf(d),
        child_key: childOf(d),
        entity_name: d.entityName ?? null,
        reason: d.reason ?? null,
        import_run_id: importRunId,
        created_at: createdAt,
      })
    }
  }
}
