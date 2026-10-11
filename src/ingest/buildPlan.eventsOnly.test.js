import { describe, it, expect } from 'vitest'
import { fieldsFor, buildPlan } from './buildPlan'

// F2: a kept <=10-minute block is created events-only only when a fixed event in the plan sits in it.
// A short block where every group prints a plain activity stays schedulable. Ordinary blocks carry no
// events_only field, so their create ops are unchanged.
const withEvent = new Set(['08:50-09:00', '03:20-03:25'])

describe('fieldsFor time_blocks events_only', () => {
  it('marks a 10-minute block that holds a fixed event events-only', () => {
    expect(fieldsFor('time_blocks', '08:50-09:00', 'c', 0, null, withEvent)).toMatchObject({ events_only: 1 })
    expect(fieldsFor('time_blocks', '03:20-03:25', 'c', 0, null, withEvent)).toMatchObject({ events_only: 1 })
  })

  it('leaves a 10-minute block with no fixed event (every group prints a plain activity) schedulable', () => {
    expect(fieldsFor('time_blocks', '10:00-10:10', 'c', 0, null, withEvent)).not.toHaveProperty('events_only')
    expect(fieldsFor('time_blocks', '08:50-09:00', 'c', 0, null)).not.toHaveProperty('events_only')
  })

  it('leaves a normal block, and a block it cannot measure, without the field', () => {
    expect(fieldsFor('time_blocks', '09:00-09:15', 'c', 0, null, new Set(['09:00-09:15']))).not.toHaveProperty('events_only')
    expect(fieldsFor('time_blocks', '04:00', 'c', 0, null, new Set(['04:00']))).not.toHaveProperty('events_only')
  })
})

describe('buildPlan events_only', () => {
  const plan = (fixedEvents) => buildPlan({
    approved: { time_blocks: ['08:50-09:00', '10:00-10:10'] },
    camp_id: 'c', cohort_id: 'k', fixedEvents,
  })
  const created = (p, name) => p.items.find((i) => i.entity === 'time_blocks' && i._name === name)

  it('flags only the short block the fixed event sits in', () => {
    const p = plan([{ name: 'Flag Raising', time_block: '08:50-09:00', days: ['Monday'] }])
    expect(created(p, '08:50-09:00').fields.events_only).toMatchObject({ to: 1 })
    expect(created(p, '10:00-10:10').fields.events_only).toBeUndefined()
  })
})
