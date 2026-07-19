// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { acquireLock, releaseLock, expireLocks } from './lockManager.js'

let db, tmpFile

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-lock-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
})

afterEach(() => {
  db.close()
  fs.unlinkSync(tmpFile)
})

describe('acquireLock', () => {
  it('grants a lock to the first requester', () => {
    const result = acquireLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: 'd1' })
    expect(result.granted).toBe(true)
  })

  it('denies a lock held by another device', () => {
    acquireLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: 'd1' })
    const result = acquireLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: 'd2' })
    expect(result.granted).toBe(false)
    expect(result.holder_device_id).toBe('d1')
  })

  it('re-grants to the same device that already holds it', () => {
    acquireLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: 'd1' })
    const result = acquireLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: 'd1' })
    expect(result.granted).toBe(true)
  })
})

describe('releaseLock', () => {
  it('frees the lock for others to acquire', () => {
    acquireLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: 'd1' })
    releaseLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: 'd1' })
    const result = acquireLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: 'd2' })
    expect(result.granted).toBe(true)
  })

  it('is a no-op when a different device attempts to release', () => {
    acquireLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: 'd1' })
    releaseLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: 'd2' })
    const result = acquireLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: 'd2' })
    expect(result.granted).toBe(false)
    expect(result.holder_device_id).toBe('d1')
  })
})

describe('device_id validation', () => {
  it('acquireLock throws on empty string device_id', () => {
    expect(() => acquireLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: '' }))
      .toThrow('device_id must be a non-empty string')
  })

  it('acquireLock throws on null device_id', () => {
    expect(() => acquireLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: null }))
      .toThrow('device_id must be a non-empty string')
  })

  it('releaseLock throws on empty string device_id', () => {
    expect(() => releaseLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: '' }))
      .toThrow('device_id must be a non-empty string')
  })
})

describe('expireLocks', () => {
  it('releases locks older than the given threshold', () => {
    acquireLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: 'd1' })
    db.prepare("UPDATE locks SET acquired_at = datetime('now', '-1 hour')").run()
    const released = expireLocks(db, 60_000)
    expect(released).toBe(1)
    const result = acquireLock(db, { entity: 'template_slots', entity_id: 's1', field: 'activity_id', device_id: 'd2' })
    expect(result.granted).toBe(true)
  })
})
