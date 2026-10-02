import { describe, it, expect } from 'vitest'
import { formatImportStopMessage } from './importStopMessage.js'

describe('formatImportStopMessage', () => {
  // Post door-swap (board q-atomic-import-primitive, part 2): the import is
  // atomic, so the sentence states that NOTHING was imported and the existing
  // setup is untouched — it names the failed row by its file position and name.
  it('formats the all-or-none rollback sentence naming the row', () => {
    const msg = formatImportStopMessage({ totalCount: 5, rowNumber: 4, rowName: 'Swim', reason: 'disk full' })
    expect(msg).toBe("Nothing was imported — row 4 of 5 ('Swim') couldn't be saved: disk full. Your existing setup was left exactly as it was.")
  })

  it('does not claim a partial import ("Imported N of") — nothing lands on failure', () => {
    const msg = formatImportStopMessage({ totalCount: 2, rowNumber: 1, rowName: 'Archery', reason: 'boom' })
    expect(msg).not.toMatch(/imported \d+ of/i)
    expect(msg).toMatch(/nothing was imported/i)
  })
})
