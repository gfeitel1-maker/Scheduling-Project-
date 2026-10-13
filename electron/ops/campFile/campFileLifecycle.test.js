// @vitest-environment node
import { describe, it, expect, afterAll } from 'vitest'
import { openTemplatedDb, cleanupTemplatedDbs } from '../../db/testDbTemplate.js'
import { appendOp } from '../operations.js'
import { makeFreshCamp } from './campFileTestSupport.js'
import { readCampStatus, canStartOver, freshProjectPath } from './campFileLifecycle.js'

afterAll(() => cleanupTemplatedDbs())

const markIncomplete = (db) => db.prepare("INSERT INTO locks (entity, entity_id, field, holder_device_id, acquired_at) VALUES ('camp_file_load', 'abc', 'incomplete', 'd', ?)").run(new Date().toISOString())

describe('readCampStatus', () => {
  it('is null with no camp', () => {
    expect(readCampStatus(openTemplatedDb().db)).toBeNull()
  })
  it('names the camp and says whether a load was left incomplete', () => {
    const { db } = openTemplatedDb()
    const camp = makeFreshCamp(db, { name: 'Camp X' })
    expect(readCampStatus(db)).toEqual({ id: camp.campId, name: 'Camp X', loadIncomplete: false })
    markIncomplete(db)
    expect(readCampStatus(db).loadIncomplete).toBe(true)
  })
})

describe('canStartOver', () => {
  it('allows a camp whose load was left incomplete', () => {
    const { db } = openTemplatedDb()
    const camp = makeFreshCamp(db)
    appendOp(db, { entity: 'tiers', entity_id: 't1', field: 'camp_id', value: camp.campId, device_id: camp.deviceId, author_user_id: camp.userId })
    appendOp(db, { entity: 'tiers', entity_id: 't1', field: 'name', value: 'Older', device_id: camp.deviceId, author_user_id: camp.userId })
    expect(canStartOver(db)).toBe(false)
    markIncomplete(db)
    expect(canStartOver(db)).toBe(true)
  })
  it('refuses a camp made by plain Start a new camp: empty tables without the marker are not abandonable', () => {
    const { db } = openTemplatedDb()
    makeFreshCamp(db)
    expect(canStartOver(db)).toBe(false)
  })
  it('refuses a real camp that has setup data and no marker', () => {
    const { db } = openTemplatedDb()
    const camp = makeFreshCamp(db)
    appendOp(db, { entity: 'groups', entity_id: 'g1', field: 'camp_id', value: camp.campId, device_id: camp.deviceId, author_user_id: camp.userId })
    appendOp(db, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk 1', device_id: camp.deviceId, author_user_id: camp.userId })
    expect(canStartOver(db)).toBe(false)
  })
})

describe('freshProjectPath', () => {
  it('is a new file beside the current one and never the current one', () => {
    const p = freshProjectPath('/data/shoresh.sqlite', () => 1700000000000)
    expect(p).toBe('/data/shoresh-fresh-1700000000000.sqlite')
    expect(p).not.toBe('/data/shoresh.sqlite')
  })
})
