import { describe, it, expect } from 'vitest'
import { UNDO_DELETE_PREFIX } from './ingest.js'
import { UNDO_DELETE_PREFIX_MIRROR } from './operations.js'

// The undo-delete prefix marks a delete as an undo of an import, not the director rejecting a row
// (T375). ingest.js mints it; operations.js and fieldProvenance.js read it and cannot import ingest.js
// (it imports them). If the two spellings drift, an undo becomes a rejection fleet-wide.
describe('undo-delete prefix', () => {
  it('the mirror spelling equals the one ingest.js mints', () => {
    expect(UNDO_DELETE_PREFIX_MIRROR).toBe(UNDO_DELETE_PREFIX)
  })
})
