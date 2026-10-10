import { describe, it, expect } from 'vitest'
import { isUntouchedSeedDays } from './seedDays.js'
import { deriveDayId } from '../../electron/ops/dayId.js'

const CAMP = 'camp-1'
const seeded = () => ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((label, i) => ({
  id: deriveDayId(CAMP, i + 1), camp_id: CAMP, label, day_of_week: i + 1, sort_order: i + 1,
}))

describe('isUntouchedSeedDays (audit 714)', () => {
  it('is true for exactly the five seeded weekdays', () => {
    expect(isUntouchedSeedDays(seeded(), CAMP)).toBe(true)
  })

  it('is false for no days at all', () => {
    expect(isUntouchedSeedDays([], CAMP)).toBe(false)
  })

  it('is false once a director renamed a day', () => {
    const days = seeded()
    days[2] = { ...days[2], label: 'Midweek' }
    expect(isUntouchedSeedDays(days, CAMP)).toBe(false)
  })

  it('is false once a day was added', () => {
    expect(isUntouchedSeedDays([...seeded(), { id: deriveDayId(CAMP, 6), camp_id: CAMP, label: 'Saturday', day_of_week: 6, sort_order: 6 }], CAMP)).toBe(false)
  })

  it('is false for five days the app did not seed (a hand-made or imported id)', () => {
    expect(isUntouchedSeedDays(seeded().map((d, i) => ({ ...d, id: `typed-${i}` })), CAMP)).toBe(false)
  })

  it('is false when a seeded weekday was removed and another added', () => {
    const days = seeded().slice(0, 4)
    days.push({ id: deriveDayId(CAMP, 6), camp_id: CAMP, label: 'Saturday', day_of_week: 6, sort_order: 5 })
    expect(isUntouchedSeedDays(days, CAMP)).toBe(false)
  })
})
