// T229 — deriving elective occurrences from live template_slots (CORRECTION
// 1: NOT from elective_sets.day_id/time_block_id, which nothing reads for
// placement). Pure, no IPC.
import { describe, it, expect } from 'vitest'
import { deriveOccurrences } from './deriveOccurrences'

const SET_ID = 'set-1'

function slot(overrides = {}) {
  return {
    id: 's1', template_id: 'tpl-1', elective_set_id: SET_ID,
    day_id: 'day-1', time_block_id: 'tb-1', group_id: 'grp-1',
    ...overrides,
  }
}

describe('deriveOccurrences', () => {
  it('collapses same-tier groups in the same cell into one occurrence', () => {
    const groups = [
      { id: 'grp-1', tier_id: 'tier-1' },
      { id: 'grp-2', tier_id: 'tier-1' },
    ]
    const slots = [
      slot({ id: 's1', group_id: 'grp-1' }),
      slot({ id: 's2', group_id: 'grp-2' }),
    ]
    const { templates } = deriveOccurrences({ slots, groups, electiveSetId: SET_ID })
    const occs = templates['tpl-1'].occurrences
    expect(occs).toHaveLength(1)
    expect(occs[0]).toMatchObject({ day_id: 'day-1', time_block_id: 'tb-1', tier_id: 'tier-1' })
  })

  it('emits an UNTIERED_GROUP finding instead of crashing when a group has no tier', () => {
    const groups = [{ id: 'grp-1', tier_id: null }]
    const slots = [slot({ group_id: 'grp-1' })]
    const { templates, findings } = deriveOccurrences({ slots, groups, electiveSetId: SET_ID })
    expect(templates['tpl-1'].occurrences).toHaveLength(0)
    expect(findings).toEqual([expect.objectContaining({ kind: 'UNTIERED_GROUP', group_id: 'grp-1' })])
  })

  it('groups occurrences by template_id', () => {
    const groups = [{ id: 'grp-1', tier_id: 'tier-1' }]
    const slots = [
      slot({ id: 's1', template_id: 'tpl-manual' }),
      slot({ id: 's2', template_id: 'tpl-generated', day_id: 'day-2' }),
    ]
    const { templates } = deriveOccurrences({ slots, groups, electiveSetId: SET_ID })
    expect(Object.keys(templates).sort()).toEqual(['tpl-generated', 'tpl-manual'])
    expect(templates['tpl-manual'].occurrences).toHaveLength(1)
    expect(templates['tpl-generated'].occurrences).toHaveLength(1)
  })

  it('returns no templates when the set has zero placements', () => {
    const { templates, findings } = deriveOccurrences({ slots: [], groups: [], electiveSetId: SET_ID })
    expect(Object.keys(templates)).toHaveLength(0)
    expect(findings).toEqual([])
  })

  it('ignores slots belonging to a different elective set', () => {
    const groups = [{ id: 'grp-1', tier_id: 'tier-1' }]
    const slots = [slot({ elective_set_id: 'other-set' })]
    const { templates } = deriveOccurrences({ slots, groups, electiveSetId: SET_ID })
    expect(Object.keys(templates)).toHaveLength(0)
  })

  // H1 — two distinct runIds against the same cell must produce two distinct
  // occurrence ids. Before this fix every call defaulted runId to the literal
  // string 'preview', so two runs collided onto the same elective_occurrences
  // primary key.
  it('derives distinct occurrence ids for distinct runIds at the same cell', () => {
    const groups = [{ id: 'grp-1', tier_id: 'tier-1' }]
    const slots = [slot({ group_id: 'grp-1' })]
    const runA = deriveOccurrences({ slots, groups, electiveSetId: SET_ID, runId: 'run-aaaa' })
    const runB = deriveOccurrences({ slots, groups, electiveSetId: SET_ID, runId: 'run-bbbb' })
    const idA = runA.templates['tpl-1'].occurrences[0].id
    const idB = runB.templates['tpl-1'].occurrences[0].id
    expect(idA).not.toEqual(idB)
  })

  // H2 — day_id/time_block_id are nullable columns on template_slots. A slot
  // carrying a null there must not reach deriveElectiveOccurrenceId's opaque()
  // guard, which throws on null and would take the whole panel down (it is
  // called unconditionally in AssignmentPanel's render body).
  it('skips a slot with a null day_id or time_block_id and emits a finding instead of throwing', () => {
    const groups = [{ id: 'grp-1', tier_id: 'tier-1' }]
    const slots = [slot({ group_id: 'grp-1', day_id: null })]
    expect(() => deriveOccurrences({ slots, groups, electiveSetId: SET_ID, runId: 'run-1' })).not.toThrow()
    const { templates, findings } = deriveOccurrences({ slots, groups, electiveSetId: SET_ID, runId: 'run-1' })
    expect(templates['tpl-1'].occurrences).toHaveLength(0)
    expect(findings).toEqual([expect.objectContaining({ kind: 'INCOMPLETE_PLACEMENT' })])
  })
})
