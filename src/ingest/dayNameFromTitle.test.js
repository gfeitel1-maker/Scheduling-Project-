import { describe, it, expect } from 'vitest'
import { dayNameFromTitle } from './extractEntities'

describe('dayNameFromTitle matches a weekday as a word, not a substring', () => {
  it.each([
    ['Monday', 'Monday'], ['Monday - All Camp', 'Monday'], ['THURSDAY', 'Thursday'], ['Rookies (Tuesday)', 'Tuesday'], ['Friday-Shabbat', 'Friday'],
    ['Monday_Schedule', 'Monday'], ['Day1_Monday', 'Monday'], ['Monday2', 'Monday'], ['MondaySchedule', 'Monday'], ['monday_v2.xlsx', 'Monday'], ['Mondays', 'Monday'], ['Tuesdays', 'Tuesday'], ['Fridays', 'Friday'],
  ])('%s -> %s', (title, day) => { expect(dayNameFromTitle(title)).toBe(day) })

  it.each(['Mondayish', 'Sundayfunday', 'Thursdaymorning', 'Notmonday', 'Bunk 4', ''])('%s -> null', (title) => {
    expect(dayNameFromTitle(title)).toBeNull()
  })
})
