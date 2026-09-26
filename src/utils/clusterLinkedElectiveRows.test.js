import { describe, it, expect } from 'vitest'
import { clusterLinkedElectiveRows } from './clusterLinkedElectiveRows.js'

describe('clusterLinkedElectiveRows', () => {
  it('passes through a non-linked row unchanged, tagged kind: span', () => {
    const rows = [{ camperId: 'c1', dayId: 'd1', timeBlockId: 't1', isLinkedChoice: false, activityName: 'Swim' }]
    expect(clusterLinkedElectiveRows(rows)).toEqual([{ kind: 'span', ...rows[0] }])
  })

  it('groups linked-choice member rows for the same (camperId, choiceId) into ONE unit', () => {
    const rows = [
      { camperId: 'c1', dayId: 'd1', timeBlockId: 't1', isLinkedChoice: true, choiceId: 'ch1', choiceLabel: 'Bundle', activityName: 'Archery' },
      { camperId: 'c1', dayId: 'd1', timeBlockId: 't3', isLinkedChoice: true, choiceId: 'ch1', choiceLabel: 'Bundle', activityName: 'Canoeing' },
    ]
    const result = clusterLinkedElectiveRows(rows)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ kind: 'linked_choice', camperId: 'c1', choiceId: 'ch1', label: 'Bundle' })
    expect(result[0].memberRows).toEqual(rows)
  })

  it('keeps two different campers with the same choiceId in two separate clusters', () => {
    const rows = [
      { camperId: 'c1', choiceId: 'ch1', choiceLabel: 'Bundle', isLinkedChoice: true },
      { camperId: 'c2', choiceId: 'ch1', choiceLabel: 'Bundle', isLinkedChoice: true },
    ]
    const result = clusterLinkedElectiveRows(rows)
    expect(result).toHaveLength(2)
    expect(new Set(result.map((r) => r.camperId))).toEqual(new Set(['c1', 'c2']))
  })

  it('does not cluster rows that merely share an activity/span shape but are not linked choices', () => {
    const rows = [
      { camperId: 'c1', dayId: 'd1', timeBlockId: 't1', isLinkedChoice: false, activityName: 'Swim' },
      { camperId: 'c1', dayId: 'd1', timeBlockId: 't2', isLinkedChoice: false, activityName: 'Swim' },
    ]
    const result = clusterLinkedElectiveRows(rows)
    expect(result).toHaveLength(2)
    expect(result.every((r) => r.kind === 'span')).toBe(true)
  })
})
