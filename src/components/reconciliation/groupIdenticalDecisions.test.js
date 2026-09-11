import { describe, it, expect } from 'vitest'
import { groupIdenticalDecisions } from './groupIdenticalDecisions'

// T127 bulk. One real import put 240 buttons on one screen: 25 identical
// "Create an empty 'Indoor Elective' elective set?" cards and 49 identical
// "Use this value / Keep current" pairs, with nothing on screen telling them
// apart.
const elective = (id, excerpt = 'Indoor Elective') => ({
  id,
  kind: 'elective_candidate',
  entity: 'elective_sets',
  reason: `This looks like an elective period. Create an empty "${excerpt}" elective set?`,
})

describe('groupIdenticalDecisions', () => {
  it('asks a repeated question once and carries every id it answers for', () => {
    const groups = groupIdenticalDecisions([elective('a'), elective('b'), elective('c')])
    expect(groups).toHaveLength(1)
    expect(groups[0].count).toBe(3)
    expect(groups[0].ids).toEqual(['a', 'b', 'c'])
    expect(groups[0].decision.id).toBe('a')
  })

  it('keeps questions apart when the words differ', () => {
    const groups = groupIdenticalDecisions([
      elective('a', 'Indoor Elective'),
      elective('b', 'Outdoor Elective'),
      elective('c', 'Indoor Elective'),
    ])
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.count)).toEqual([2, 1])
  })

  it('keeps questions apart when the kind or entity differs, even if the words match', () => {
    const base = { reason: 'Same sentence.', kind: 'confirm_value', entity: 'activities' }
    const groups = groupIdenticalDecisions([
      { ...base, id: 'a' },
      { ...base, id: 'b', kind: 'confirm_change' },
      { ...base, id: 'c', entity: 'groups' },
    ])
    expect(groups).toHaveLength(3)
  })

  it('preserves the order the lane put them in', () => {
    const groups = groupIdenticalDecisions([
      elective('a', 'Outdoor Elective'),
      elective('b', 'Indoor Elective'),
      elective('c', 'Outdoor Elective'),
    ])
    expect(groups.map((g) => g.decision.id)).toEqual(['a', 'b'])
  })

  it('leaves a list of genuinely different questions completely alone', () => {
    const decisions = [
      { id: 'a', kind: 'confirm_value', entity: 'activities', reason: 'Swim?' },
      { id: 'b', kind: 'confirm_value', entity: 'activities', reason: 'Art?' },
    ]
    const groups = groupIdenticalDecisions(decisions)
    expect(groups).toHaveLength(2)
    expect(groups.every((g) => g.count === 1)).toBe(true)
  })

  it('does not merge the decisions themselves — every id is still answered separately', () => {
    // The group is a presentation of several decisions, not one decision
    // standing in for them, so the commit payload matches a director who
    // clicked through all of them by hand.
    const groups = groupIdenticalDecisions([elective('a'), elective('b')])
    expect(groups[0].ids).toHaveLength(2)
    expect(groups[0].ids).not.toBe(groups[0].decision.id)
  })

  it('tolerates an empty or missing list', () => {
    expect(groupIdenticalDecisions([])).toEqual([])
    expect(groupIdenticalDecisions()).toEqual([])
  })

  it('does not collapse two decisions that merely both lack a reason', () => {
    // A null reason is absence of information, not evidence of sameness — but
    // kind+entity still separate them, which is what keeps this safe.
    const groups = groupIdenticalDecisions([
      { id: 'a', kind: 'confirm_value', entity: 'activities' },
      { id: 'b', kind: 'resolve_conflict', entity: 'activities' },
    ])
    expect(groups).toHaveLength(2)
  })
})
