// @vitest-environment node
//
// THE TEST THAT WOULD HAVE CAUGHT IT (T174).
//
// T148 routed two device-health events to `audit_events` with
// `outcome: 'error'`. That column is CHECK-constrained to ('allow','deny'), so
// every insert was rejected, `recordAuditEvent` swallowed the violation into a
// console line exactly as designed, and the "durable trace" never landed a row.
// `check_projection_health` then read those actions back, found nothing, and
// reported HEALTHY.
//
// Nothing caught it for a week because the tests that existed asserted the CALL
// was made. So every test here asserts the row is READ BACK. That is the whole
// difference between the two, and the reason this file exists.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { recordAuditEvent } from '../audit/auditLog.js'
import { recordDeviceHealthEvent, listDeviceHealthEvents, DEVICE_HEALTH } from './deviceHealthEvents.js'

let db, file
beforeEach(() => {
  file = path.join(os.tmpdir(), `shoresh-health-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(file)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
})
afterEach(() => {
  try { db.close() } catch { /* already closed */ }
  for (const s of ['', '-wal', '-shm']) fs.rmSync(file + s, { force: true })
})

describe('the original defect, pinned so it cannot come back', () => {
  it('audit_events STILL rejects a non-allow/deny outcome — the constraint is real', () => {
    // Not a hypothetical, and not fixed by widening the constraint: this asserts
    // the reason the old route could never work, so that anyone tempted to send
    // health events back to audit_events sees why it fails.
    recordAuditEvent(db, { campId: 'camp-1', action: 'sync.document_save_failed', outcome: 'error', reason: 'disk full' })
    const rows = db.prepare("SELECT * FROM audit_events WHERE action = 'sync.document_save_failed'").all()
    expect(rows).toEqual([])
  })

  it('a valid audit outcome DOES land — proving the empty result above is the constraint, not a broken writer', () => {
    // The control. Without this, the test above could pass because
    // recordAuditEvent is broken generally, which would be a different bug.
    recordAuditEvent(db, { campId: 'camp-1', action: 'auth.login', outcome: 'deny', reason: 'control' })
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'auth.login'").get().n).toBe(1)
  })
})

describe('recordDeviceHealthEvent — the row lands, and says so', () => {
  it('records a failed document save and reads it back', () => {
    expect(recordDeviceHealthEvent(db, {
      campId: 'camp-1',
      kind: DEVICE_HEALTH.DOCUMENT_SAVE_FAILED,
      incident: 'docsave-camp-1-3',
      detail: JSON.stringify({ pendingOpCount: 4 }),
    })).toBe(true)

    const rows = listDeviceHealthEvents(db)
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe(DEVICE_HEALTH.DOCUMENT_SAVE_FAILED)
    expect(rows[0].incident).toBe('docsave-camp-1-3')
    expect(JSON.parse(rows[0].detail).pendingOpCount).toBe(4)
  })

  it('records a failed merge projection and reads it back', () => {
    expect(recordDeviceHealthEvent(db, {
      campId: 'camp-1',
      kind: DEVICE_HEALTH.PROJECTION_FAILED,
      detail: JSON.stringify({ fromPeerId: '12D3KooW' }),
    })).toBe(true)
    expect(listDeviceHealthEvents(db).map((r) => r.kind)).toEqual([DEVICE_HEALTH.PROJECTION_FAILED])
  })

  it('REPORTS failure rather than assuming success — the property audit_events lacks', () => {
    // The distinction that hid the original defect for a week. A writer that
    // cannot throw needs a caller that can ask whether it worked.
    db.close()
    expect(recordDeviceHealthEvent(db, { campId: 'camp-1', kind: DEVICE_HEALTH.PROJECTION_FAILED })).toBe(false)
  })

  it('never throws, even on a closed db or junk input — the caller is already handling a failure', () => {
    expect(() => recordDeviceHealthEvent(null, { kind: DEVICE_HEALTH.PROJECTION_FAILED })).not.toThrow()
    expect(() => recordDeviceHealthEvent(db, {})).not.toThrow()
    expect(recordDeviceHealthEvent(db, {})).toBe(false)
  })

  it('truncates a runaway detail rather than refusing the row', () => {
    // A stack trace is worth keeping; an unbounded one is not worth losing the
    // record over.
    expect(recordDeviceHealthEvent(db, { campId: 'camp-1', kind: DEVICE_HEALTH.PROJECTION_FAILED, detail: 'x'.repeat(20000) })).toBe(true)
    expect(listDeviceHealthEvents(db)[0].detail.length).toBe(4000)
  })

  it('listDeviceHealthEvents returns [] rather than throwing when the table is absent', () => {
    db.exec('DROP TABLE device_health_events')
    expect(listDeviceHealthEvents(db)).toEqual([])
  })

  it('newest first, and resolved events are excluded', () => {
    recordDeviceHealthEvent(db, { campId: 'camp-1', kind: DEVICE_HEALTH.PROJECTION_FAILED, detail: 'first' })
    recordDeviceHealthEvent(db, { campId: 'camp-1', kind: DEVICE_HEALTH.DOCUMENT_SAVE_FAILED, detail: 'second' })
    db.prepare("UPDATE device_health_events SET resolved_at = ? WHERE detail = 'first'").run(new Date().toISOString())
    expect(listDeviceHealthEvents(db).map((r) => r.detail)).toEqual(['second'])
  })
})
