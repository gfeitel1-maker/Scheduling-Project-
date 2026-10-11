import { describe, it, expect } from 'vitest'
import { fieldsFor } from './buildPlan'

// F2: the import keeps a <=10-minute block only because most groups print an event in it, so the block
// is created events-only. Ordinary blocks carry no events_only field, so their create ops are unchanged.
describe('fieldsFor time_blocks events_only', () => {
  it('marks a 10-minute block events-only', () => {
    expect(fieldsFor('time_blocks', '08:50-09:00', 'c', 0, null)).toMatchObject({ events_only: 1 })
    expect(fieldsFor('time_blocks', '03:20-03:25', 'c', 0, null)).toMatchObject({ events_only: 1 })
  })

  it('leaves a normal block, and a block it cannot measure, without the field', () => {
    expect(fieldsFor('time_blocks', '09:00-09:15', 'c', 0, null)).not.toHaveProperty('events_only')
    expect(fieldsFor('time_blocks', '04:00', 'c', 0, null)).not.toHaveProperty('events_only')
  })
})
