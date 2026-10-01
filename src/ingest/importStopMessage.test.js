import { describe, it, expect } from 'vitest'
import { formatImportStopMessage } from './importStopMessage.js'

describe('formatImportStopMessage', () => {
  it('formats the hard-stop sentence and never claims atomicity', () => {
    const msg = formatImportStopMessage({ importedCount: 3, totalCount: 5, rowNumber: 4, rowName: 'Swim', reason: 'disk full' })
    expect(msg).toBe("Imported 3 of 5 rows; row 4 ('Swim') failed: disk full. No further rows were written.")
    expect(msg.toLowerCase()).not.toContain('atomic')
  })
})
