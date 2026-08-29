// @vitest-environment node
//
// electron/ops/openReconciliationDecisions.js
// docs/adr/2026-08-28-persisted-reconciliation-decisions.md
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import {
  listOpenReconciliationDecisions,
  dismissOpenReconciliationDecisions,
  replaceOpenDecisionsForCommit,
} from './openReconciliationDecisions.js'

const files = []
afterEach(() => {
  for (const f of files.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      if (fs.existsSync(f + suffix)) fs.unlinkSync(f + suffix)
    }
  }
})

function tmpDb(tag) {
  const file = path.join(os.tmpdir(), `shoresh-ord-${tag}-${Date.now()}-${Math.random()}.sqlite`)
  files.push(file)
  return openLocalDb(file)
}

function seedCamp(db, id = 'camp1') {
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(id, 'Camp', 'a'.repeat(64))
  return id
}

describe('listOpenReconciliationDecisions / dismissOpenReconciliationDecisions', () => {
  it('returns [] and {ok:true, dismissed:0} on a db without the table, never throws', () => {
    const db = tmpDb('no-table')
    db.exec('DROP TABLE open_reconciliation_decisions')
    expect(listOpenReconciliationDecisions(db, 'camp1')).toEqual([])
    expect(dismissOpenReconciliationDecisions(db, ['x'])).toEqual({ ok: true, dismissed: 0 })
    db.close()
  })

  it('lists rows scoped to camp_id', () => {
    const db = tmpDb('scope')
    const campA = seedCamp(db, 'campA')
    seedCamp(db, 'campB')
    replaceOpenDecisionsForCommit(db, {
      campId: campA,
      decisions: [{ id: 'groups:g1', entity: 'groups', entityId: 'g1', entityName: 'Bunk 1', kind: 'confirm_value', reason: 'r' }],
      importRunId: 'run1',
      createdAt: '2026-08-28T00:00:00.000Z',
    })
    replaceOpenDecisionsForCommit(db, {
      campId: 'campB',
      decisions: [{ id: 'groups:g2', entity: 'groups', entityId: 'g2', entityName: 'Bunk 2', kind: 'confirm_value', reason: 'r' }],
      importRunId: 'run1',
      createdAt: '2026-08-28T00:00:00.000Z',
    })
    const rows = listOpenReconciliationDecisions(db, campA)
    expect(rows.map((r) => r.id)).toEqual(['groups:g1'])
    db.close()
  })

  it('dismiss deletes only the given ids, unconditionally — succeeds even for an id whose entity no longer exists', () => {
    const db = tmpDb('dismiss')
    const campId = seedCamp(db)
    replaceOpenDecisionsForCommit(db, {
      campId,
      decisions: [
        { id: 'groups:g1', entity: 'groups', entityId: 'g1', entityName: 'Bunk 1', kind: 'confirm_value', reason: 'r' },
        { id: 'groups:g2', entity: 'groups', entityId: 'g2', entityName: 'Bunk 2', kind: 'confirm_value', reason: 'r' },
      ],
      importRunId: 'run1',
      createdAt: '2026-08-28T00:00:00.000Z',
    })
    // g1's "entity" (a real groups row) is never inserted here — dismiss
    // must not care, and must not join to the groups table at all.
    const result = dismissOpenReconciliationDecisions(db, ['groups:g1', 'does-not-exist'])
    expect(result).toEqual({ ok: true, dismissed: 1 })
    expect(listOpenReconciliationDecisions(db, campId).map((r) => r.id)).toEqual(['groups:g2'])
    db.close()
  })
})

describe('replaceOpenDecisionsForCommit', () => {
  it('an all-resolved commit leaves the touched scope empty', () => {
    const db = tmpDb('all-resolved')
    const campId = seedCamp(db)
    replaceOpenDecisionsForCommit(db, {
      campId,
      decisions: [{ id: 'groups:g1', entity: 'groups', entityId: 'g1', entityName: 'Bunk 1', kind: 'confirm_value', reason: 'r' }],
      importRunId: 'run1',
      createdAt: '2026-08-28T00:00:00.000Z',
    })
    expect(listOpenReconciliationDecisions(db, campId)).toHaveLength(1)

    // Re-import touches 'groups' again but now fully resolved: decisions is
    // empty, but touchedEntityTypes still names 'groups' explicitly — the
    // scope is cleared to empty, not left stale.
    replaceOpenDecisionsForCommit(db, {
      campId, decisions: [], touchedEntityTypes: ['groups'], importRunId: 'run2', createdAt: '2026-08-28T00:01:00.000Z',
    })
    expect(listOpenReconciliationDecisions(db, campId)).toHaveLength(0)
  })

  it('a commit that resolves some and leaves others persists only the remainder, scoped by (entity_type, cohort_id)', () => {
    const db = tmpDb('partial')
    const campId = seedCamp(db)
    replaceOpenDecisionsForCommit(db, {
      campId,
      decisions: [
        { id: 'groups:g1', entity: 'groups', entityId: 'g1', entityName: 'Bunk 1', kind: 'confirm_value', reason: 'r' },
        { id: 'groups:g2', entity: 'groups', entityId: 'g2', entityName: 'Bunk 2', kind: 'confirm_value', reason: 'r' },
      ],
      importRunId: 'run1',
      createdAt: '2026-08-28T00:00:00.000Z',
    })
    // Re-import: g1 resolved (dropped out), g2 still open.
    replaceOpenDecisionsForCommit(db, {
      campId,
      decisions: [{ id: 'groups:g2', entity: 'groups', entityId: 'g2', entityName: 'Bunk 2', kind: 'confirm_value', reason: 'r' }],
      importRunId: 'run2',
      createdAt: '2026-08-28T00:01:00.000Z',
    })
    expect(listOpenReconciliationDecisions(db, campId).map((r) => r.id)).toEqual(['groups:g2'])
  })

  it('a commit touching entity_type A never deletes existing open rows for untouched entity_type B (amnesty-by-omission)', () => {
    const db = tmpDb('amnesty-type')
    const campId = seedCamp(db)
    replaceOpenDecisionsForCommit(db, {
      campId,
      decisions: [
        { id: 'groups:g1', entity: 'groups', entityId: 'g1', entityName: 'Bunk 1', kind: 'confirm_value', reason: 'r' },
        { id: 'activities:a1', entity: 'activities', entityId: 'a1', entityName: 'Swim', kind: 'confirm_value', reason: 'r' },
      ],
      importRunId: 'run1',
      createdAt: '2026-08-28T00:00:00.000Z',
    })
    // Re-import touches ONLY activities — groups' open row must survive.
    replaceOpenDecisionsForCommit(db, {
      campId,
      decisions: [{ id: 'activities:a1', entity: 'activities', entityId: 'a1', entityName: 'Swim', kind: 'confirm_value', reason: 'r' }],
      importRunId: 'run2',
      createdAt: '2026-08-28T00:01:00.000Z',
    })
    const ids = listOpenReconciliationDecisions(db, campId).map((r) => r.id).sort()
    expect(ids).toEqual(['activities:a1', 'groups:g1'])
  })

  it('a commit re-importing cohort B tiers never deletes cohort A still-open tier decisions (Finding 2)', () => {
    const db = tmpDb('amnesty-cohort')
    const campId = seedCamp(db)
    replaceOpenDecisionsForCommit(db, {
      campId,
      cohortId: 'cohortA',
      decisions: [{ id: 'tiers:tA', entity: 'tiers', entityId: 'tA', entityName: 'Seniors A', kind: 'confirm_value', reason: 'r' }],
      importRunId: 'run1',
      createdAt: '2026-08-28T00:00:00.000Z',
    })
    replaceOpenDecisionsForCommit(db, {
      campId,
      cohortId: 'cohortB',
      decisions: [{ id: 'tiers:tB', entity: 'tiers', entityId: 'tB', entityName: 'Seniors B', kind: 'confirm_value', reason: 'r' }],
      importRunId: 'run2',
      createdAt: '2026-08-28T00:01:00.000Z',
    })
    const ids = listOpenReconciliationDecisions(db, campId).map((r) => r.id).sort()
    expect(ids).toEqual(['tiers:tA', 'tiers:tB'])
  })

  it('a cohort-scoped entity type whose open row has cohort_id = NULL is still matched and replaced (cohort_id IS ?, not = ?)', () => {
    const db = tmpDb('null-cohort')
    const campId = seedCamp(db)
    // Write with cohortId omitted (null) — a tiers row with cohort_id = NULL.
    replaceOpenDecisionsForCommit(db, {
      campId,
      decisions: [{ id: 'tiers:t1', entity: 'tiers', entityId: 't1', entityName: 'Seniors', kind: 'confirm_value', reason: 'r' }],
      importRunId: 'run1',
      createdAt: '2026-08-28T00:00:00.000Z',
    })
    expect(db.prepare('SELECT cohort_id FROM open_reconciliation_decisions WHERE id = ?').get('tiers:t1').cohort_id).toBeNull()

    // Re-import, same (NULL) cohort scope, now resolved — must be cleared.
    // This is the regression this test protects: a naive `cohort_id = ?`
    // predicate never matches NULL, so the stale row would survive.
    replaceOpenDecisionsForCommit(db, {
      campId, cohortId: null, decisions: [], touchedEntityTypes: ['tiers'], importRunId: 'run2', createdAt: '2026-08-28T00:01:00.000Z',
    })
    expect(listOpenReconciliationDecisions(db, campId)).toHaveLength(0)

    replaceOpenDecisionsForCommit(db, {
      campId,
      cohortId: null,
      decisions: [{ id: 'tiers:t2', entity: 'tiers', entityId: 't2', entityName: 'Juniors', kind: 'confirm_value', reason: 'r' }],
      importRunId: 'run3',
      createdAt: '2026-08-28T00:02:00.000Z',
    })
    const ids = listOpenReconciliationDecisions(db, campId).map((r) => r.id)
    expect(ids).toEqual(['tiers:t2'])
  })
})
