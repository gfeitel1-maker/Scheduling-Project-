import { describe, it, expect } from 'vitest'
import { blocksThatContinue } from './blockOverlap.js'

// T219: two blocks are one double period only when the first ends exactly as the next begins.
// A lunch, an event period or any time gap between two chugim keeps them separate.
describe('blocksThatContinue', () => {
  it('names each block that starts when the block before it ends, and no block across a gap', () => {
    const blocks = [
      { id: 'a', start_time: '10:00', end_time: '11:00' },
      { id: 'b', start_time: '11:00', end_time: '12:00' },
      { id: 'c', start_time: '12:15', end_time: '13:00' },
      { id: 'd', start_time: null, end_time: null },
    ]
    expect([...blocksThatContinue(blocks)]).toEqual(['b'])
  })
})
