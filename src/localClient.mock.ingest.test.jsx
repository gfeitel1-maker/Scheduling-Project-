// @vitest-environment jsdom
//
// T74 — dev mock ingest fidelity. These tests pin the localhost:5200 dev mock
// (src/localClient.mock.js `ingestCommit`) to the REAL committer's observable
// contract (electron/ops/ingest.js commitIngest/commitPlan): recognition →
// `unchanged`, field diff → `update` under the Policy-A hand-edit gate, the HELD
// outcome `{ held, conflicts }`, and the T73 `resolutions` re-commit. The mock
// reuses the SAME pure `buildPlan` the real path does, so a divergence here is a
// real fidelity gap, not a test artifact.

import { describe, it, expect, beforeEach } from 'vitest'
import { mockShoresh } from './localClient.mock'

async function bootstrap() {
  await mockShoresh.bootstrapCamp({ campName: 'T74 Camp', adminName: 'Dir', adminPin: '1234' })
}

const listNames = async (entity) => (await mockShoresh.list(null, entity)).map((r) => r.name)

beforeEach(() => {
  // This runner's default localStorage stub is incomplete (no clear/removeItem),
  // so install a simple in-memory one. A fresh store per test isolates the mock.
  const store = new Map()
  const ls = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)) },
    removeItem: (k) => { store.delete(k) },
    clear: () => { store.clear() },
  }
  globalThis.localStorage = ls
})

describe('mock ingestCommit — recognition (S1a)', () => {
  it('re-import of an already-present camp recognizes, adds no duplicate rows', async () => {
    await bootstrap()
    const approved = { activities: ['Swim', 'Art'] }

    const first = await mockShoresh.ingestCommit({ approved })
    expect(first.held).toBeFalsy()
    expect(first.total).toBe(2)
    expect(await listNames('activities')).toEqual(['Swim', 'Art'])

    const second = await mockShoresh.ingestCommit({ approved })
    expect(second.held).toBeFalsy()
    expect(second.total).toBe(0)
    expect(second.created.activities).toBe(0)
    // No duplicate rows — still exactly the two recognized activities.
    expect(await listNames('activities')).toEqual(['Swim', 'Art'])
  })
})

describe('mock ingestCommit — hand-edit protection + stale resolution (S2b/T73)', () => {
  async function seedEditedGroup() {
    await bootstrap()
    // Import-created group: availability 'all', source 'import'.
    await mockShoresh.ingestCommit({ approved: { groups: ['Bunk 1'] } })
    const group = (await mockShoresh.list(null, 'groups')).find((g) => g.name === 'Bunk 1')
    // Director hand-edits availability through the normal write() path → 'human'.
    await mockShoresh.write({ entity: 'groups', entity_id: group.id, field: 'availability', value: 'weekdays' })
    return group
  }

  it('re-import proposing a different value for a hand-edited field HOLDS with a stale conflict', async () => {
    await seedEditedGroup()

    const outcome = await mockShoresh.ingestCommit({ approved: { groups: ['Bunk 1'] } })
    expect(outcome.held).toBe(true)
    expect(outcome.conflicts).toHaveLength(1)
    const c = outcome.conflicts[0]
    expect(c.reason).toBe('stale')
    expect(c.entity).toBe('groups')
    expect(c._name).toBe('Bunk 1')
    expect(c.fields.availability.from).toBe('weekdays')
    expect(c.fields.availability.to).toBe('all')
    // Hold-the-whole: nothing was written, the hand-edit is intact.
    const group = (await mockShoresh.list(null, 'groups')).find((g) => g.name === 'Bunk 1')
    expect(group.availability).toBe('weekdays')
  })

  it('resolutions accept writes the import value, and a second re-import is quiet', async () => {
    await seedEditedGroup()
    const resolutions = [{ entity: 'groups', name: 'Bunk 1', reason: 'stale', field: 'availability', choice: 'accept' }]

    const accepted = await mockShoresh.ingestCommit({ approved: { groups: ['Bunk 1'] }, resolutions })
    expect(accepted.held).toBeFalsy()
    let group = (await mockShoresh.list(null, 'groups')).find((g) => g.name === 'Bunk 1')
    expect(group.availability).toBe('all')

    // The accepted value is now import-owned → the NULL-trap escape: a plain
    // re-import no longer conflicts.
    const quiet = await mockShoresh.ingestCommit({ approved: { groups: ['Bunk 1'] } })
    expect(quiet.held).toBeFalsy()
    group = (await mockShoresh.list(null, 'groups')).find((g) => g.name === 'Bunk 1')
    expect(group.availability).toBe('all')
  })

  it('resolutions keep preserves the hand-edited value', async () => {
    await seedEditedGroup()
    const resolutions = [{ entity: 'groups', name: 'Bunk 1', reason: 'stale', field: 'availability', choice: 'keep' }]

    const kept = await mockShoresh.ingestCommit({ approved: { groups: ['Bunk 1'] }, resolutions })
    expect(kept.held).toBeFalsy()
    const group = (await mockShoresh.list(null, 'groups')).find((g) => g.name === 'Bunk 1')
    expect(group.availability).toBe('weekdays')
  })
})

describe('mock ingestCommit — ambiguous identity (S1a §3 / T73)', () => {
  async function seedTwoColliding() {
    await bootstrap()
    // Two live rows whose raw names differ but normalize alike, both legal under
    // UNIQUE(camp_id, name). Written directly so they are human-authored rows.
    await mockShoresh.write({ entity: 'activities', entity_id: 'act-art', field: 'name', value: 'Art' })
    await mockShoresh.write({ entity: 'activities', entity_id: 'act-art2', field: 'name', value: 'art ' })
  }

  it('one incoming label matching two colliding rows HOLDS as ambiguous_identity', async () => {
    await seedTwoColliding()
    const outcome = await mockShoresh.ingestCommit({ approved: { activities: ['Art'] } })
    expect(outcome.held).toBe(true)
    expect(outcome.conflicts).toHaveLength(1)
    const c = outcome.conflicts[0]
    expect(c.reason).toBe('ambiguous_identity')
    expect(c.entity).toBe('activities')
    expect(c._name).toBe('Art')
    expect(c.evidence.candidates.map((x) => x.id).sort()).toEqual(['act-art', 'act-art2'])
    // Nothing added.
    expect((await mockShoresh.list(null, 'activities')).length).toBe(2)
  })

  it('resolving to an existing candidate commits with no new row', async () => {
    await seedTwoColliding()
    const resolutions = [{ entity: 'activities', name: 'Art', reason: 'ambiguous_identity', choice: 'existing', entity_id: 'act-art' }]
    const outcome = await mockShoresh.ingestCommit({ approved: { activities: ['Art'] }, resolutions })
    expect(outcome.held).toBeFalsy()
    expect((await mockShoresh.list(null, 'activities')).length).toBe(2)
  })

  it('resolving to create (distinct raw name) commits a new row', async () => {
    await seedTwoColliding()
    // Incoming raw name "ART" normalizes into the collision but is a distinct raw
    // name, so "create new" succeeds against UNIQUE(camp_id, name).
    const resolutions = [{ entity: 'activities', name: 'ART', reason: 'ambiguous_identity', choice: 'create' }]
    const outcome = await mockShoresh.ingestCommit({ approved: { activities: ['ART'] }, resolutions })
    expect(outcome.held).toBeFalsy()
    expect(outcome.created.activities).toBe(1)
    expect((await mockShoresh.list(null, 'activities')).length).toBe(3)
  })
})
