// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../db/testDbTemplate.js'
import { markRemovedFromCamp, isRemovedFromCamp, healRemovedMark } from './selfRemoval.js'

afterEach(cleanupTemplatedDbs)
const setStatus = (db, id, status) => db.prepare('INSERT OR REPLACE INTO authority_cache (device_id, status, updated_at) VALUES (?, ?, ?)').run(id, status, 'now')

describe('healRemovedMark', () => {
  it('clears a removed mark once own authority state no longer says revoked', () => {
    const { db } = openTemplatedDb()
    setStatus(db, 'me', 'revoked')
    markRemovedFromCamp(db, { peerId: 'p' })
    setStatus(db, 'me', 'admin')
    expect(healRemovedMark(db, 'me')).toBe(true)
    expect(isRemovedFromCamp(db)).toBe(false)
    db.close()
  })
  it('keeps the mark while own authority state still says revoked', () => {
    const { db } = openTemplatedDb()
    setStatus(db, 'me', 'revoked')
    markRemovedFromCamp(db, { peerId: 'p' })
    expect(healRemovedMark(db, 'me')).toBe(false)
    expect(isRemovedFromCamp(db)).toBe(true)
    db.close()
  })
  it('does nothing when there is no mark', () => {
    const { db } = openTemplatedDb()
    expect(healRemovedMark(db, 'me')).toBe(false)
    db.close()
  })
})
