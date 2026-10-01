// @vitest-environment node
//
// T322 S3b — the per-peer erasure-state read that the Device Manager badge renders.
// docs/work/tickets/T322-per-peer-erasure-state-ui.md (S3b), scoping note
// docs/work/specs/2026-10-01-t233-s3-per-peer-erasure-state-ui-design.md.
//
// A peer is LOGICALLY_ERASED only when, for EVERY real purge-tombstone, it has
// self-reported (peer_tombstone_reports) an applied version >= that tombstone's
// version; otherwise UNKNOWN (including a peer that has reported nothing, and a
// peer behind on even one tombstone). This is the honest per-id lookup, never a
// scalar-vs-max comparison (tombstone `version` is per-id, not a global sequence).
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { openTemplatedDb, cleanupTemplatedDbs } from '../db/testDbTemplate.js'
import {
  computePeerErasureStates,
  listPeerErasureStateFromDb,
} from './peerErasureState.js'

afterAll(() => {
  cleanupTemplatedDbs()
})

describe('computePeerErasureStates — pure per-peer verdict', () => {
  it('marks a peer LOGICALLY_ERASED only when it has caught up on every tombstone', () => {
    const states = computePeerErasureStates({
      tombstones: [
        { id: 'camper-a', version: 1 },
        { id: 'camper-b', version: 2 },
      ],
      reports: [
        { device_id: 'peer-1', tombstone_id: 'camper-a', version: 1 },
        { device_id: 'peer-1', tombstone_id: 'camper-b', version: 2 },
        // peer-2 is behind on camper-b (reported v1 < required v2)
        { device_id: 'peer-2', tombstone_id: 'camper-a', version: 1 },
        { device_id: 'peer-2', tombstone_id: 'camper-b', version: 1 },
      ],
      peerDeviceIds: ['peer-1', 'peer-2'],
    })
    expect(states).toEqual({ 'peer-1': 'LOGICALLY_ERASED', 'peer-2': 'UNKNOWN' })
  })

  it('a peer that has reported nothing reads UNKNOWN, never silently erased', () => {
    const states = computePeerErasureStates({
      tombstones: [{ id: 'camper-a', version: 1 }],
      reports: [],
      peerDeviceIds: ['offline-peer'],
    })
    expect(states).toEqual({ 'offline-peer': 'UNKNOWN' })
  })

  it('a peer missing even one tombstone reads UNKNOWN (never a count it cannot back)', () => {
    const states = computePeerErasureStates({
      tombstones: [
        { id: 'camper-a', version: 1 },
        { id: 'camper-b', version: 1 },
      ],
      // has camper-a, never saw camper-b
      reports: [{ device_id: 'peer-1', tombstone_id: 'camper-a', version: 1 }],
      peerDeviceIds: ['peer-1'],
    })
    expect(states).toEqual({ 'peer-1': 'UNKNOWN' })
  })

  it('a higher reported version still satisfies a lower-versioned tombstone', () => {
    const states = computePeerErasureStates({
      tombstones: [{ id: 'camper-a', version: 2 }],
      reports: [{ device_id: 'peer-1', tombstone_id: 'camper-a', version: 5 }],
      peerDeviceIds: ['peer-1'],
    })
    expect(states).toEqual({ 'peer-1': 'LOGICALLY_ERASED' })
  })

  it('treats a malformed tombstone version as not-caught-up, never a fabricated erased', () => {
    const states = computePeerErasureStates({
      tombstones: [{ id: 'camper-a', version: Number.NaN }],
      // the peer HAS a report for this id — the bug would be flipping it erased
      reports: [{ device_id: 'peer-1', tombstone_id: 'camper-a', version: 9 }],
      peerDeviceIds: ['peer-1'],
    })
    expect(states).toEqual({ 'peer-1': 'UNKNOWN' })
  })

  it('returns an empty map when there are no tombstones (no purge → nothing to show)', () => {
    const states = computePeerErasureStates({
      tombstones: [],
      reports: [{ device_id: 'peer-1', tombstone_id: 'camper-a', version: 1 }],
      peerDeviceIds: ['peer-1'],
    })
    expect(states).toEqual({})
  })

  it('ignores malformed report rows without crashing or fabricating a verdict', () => {
    const states = computePeerErasureStates({
      tombstones: [{ id: 'camper-a', version: 1 }],
      reports: [
        null,
        { device_id: 'peer-1', tombstone_id: 'camper-a', version: 'oops' },
        { device_id: 'peer-1', tombstone_id: null, version: 1 },
        { device_id: 'peer-1', tombstone_id: 'camper-a', version: 1 }, // the only good one
      ],
      peerDeviceIds: ['peer-1'],
    })
    expect(states).toEqual({ 'peer-1': 'LOGICALLY_ERASED' })
  })
})

describe('listPeerErasureStateFromDb — against a real db', () => {
  let db
  beforeEach(() => {
    db = openTemplatedDb().db
  })

  function insertDevice(id, pairingStatus) {
    db.prepare('INSERT OR IGNORE INTO devices (id, name, pairing_status) VALUES (?, ?, ?)').run(
      id,
      id,
      pairingStatus,
    )
  }
  function insertTombstone(id, version) {
    db.prepare(
      "INSERT OR REPLACE INTO tombstones (id, entity, version, sig, created_at) VALUES (?, 'campers', ?, 'sig', ?)",
    ).run(id, version, new Date().toISOString())
  }
  function insertReport(deviceId, tombstoneId, version) {
    db.prepare(
      'INSERT OR REPLACE INTO peer_tombstone_reports (device_id, tombstone_id, version, reported_at) VALUES (?, ?, ?, ?)',
    ).run(deviceId, tombstoneId, version, new Date().toISOString())
  }

  it('reports hasErasure=false and no states when no real tombstone exists', () => {
    insertDevice('local', 'authorized')
    insertDevice('peer-1', 'authorized')
    const result = listPeerErasureStateFromDb(db, { localDeviceId: 'local' })
    expect(result.hasErasure).toBe(false)
    expect(result.states).toEqual({})
  })

  it('excludes the version-0 empty-sig projection placeholder tombstone', () => {
    insertDevice('peer-1', 'authorized')
    // the placeholder a field-by-field projection creates (projections.js ensureExists)
    db.prepare("INSERT OR IGNORE INTO tombstones (id, entity, version, sig) VALUES ('placeholder', '', 0, '')").run()
    const result = listPeerErasureStateFromDb(db, { localDeviceId: 'local' })
    // a version-0 placeholder is not a real purge event
    expect(result.hasErasure).toBe(false)
    expect(result.states).toEqual({})
  })

  it('excludes the local device from the per-peer states', () => {
    insertDevice('local', 'authorized')
    insertDevice('peer-1', 'authorized')
    insertTombstone('camper-a', 1)
    insertReport('peer-1', 'camper-a', 1)
    const result = listPeerErasureStateFromDb(db, { localDeviceId: 'local' })
    expect(result.hasErasure).toBe(true)
    expect(result.states).toEqual({ 'peer-1': 'LOGICALLY_ERASED' })
    expect(result.localDeviceId).toBe('local')
    expect(Object.keys(result.states)).not.toContain('local')
  })

  it("excludes phantom 'unknown' pairing_status devices (same filter as listDevices)", () => {
    insertDevice('peer-1', 'authorized')
    insertDevice('phantom', 'unknown')
    insertTombstone('camper-a', 1)
    const result = listPeerErasureStateFromDb(db, { localDeviceId: 'local' })
    expect(Object.keys(result.states)).toEqual(['peer-1'])
    expect(result.states['peer-1']).toBe('UNKNOWN')
  })

  it('an authorized peer with no report reads UNKNOWN once a purge exists', () => {
    insertDevice('peer-1', 'authorized')
    insertTombstone('camper-a', 3)
    insertReport('peer-1', 'camper-a', 2) // behind
    const result = listPeerErasureStateFromDb(db, { localDeviceId: 'local' })
    expect(result.states).toEqual({ 'peer-1': 'UNKNOWN' })
  })
})
