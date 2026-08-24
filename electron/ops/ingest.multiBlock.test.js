// Slice B — director-confirmed multi-block candidates.
// docs/adr/2026-08-24-merged-cell-multiblock-ingest.md, Slice B addendum.
//
// A recurring confirmation extends the ordinary fixedEvents commit block
// (span_blocks threaded onto the anchor_activities INSERT). A one-off
// confirmation writes an `events` catalog row only (surface-then-fill, no
// template_slots placement). Unconfirmed candidates never reach commitIngest
// at all (ImportScreen only sends a decision, never an "ignore" third state)
// — this file verifies commitIngest's own contract: nothing in
// fixedEvents/multiBlockEvents is a no-op magically skipped, everything
// passed in gets written.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openLocalDb } from '../db/localDb.js'
import { commitIngest } from './ingest.js'

let db, tmpFile, campId
const deviceId = 'device-1'

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `shoresh-multiblock-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(tmpFile)
  campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'Camp Test', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run(deviceId, 'Test Device')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'Ruth', 'h', 's', 'admin')").run('u1', campId)
})

afterEach(() => {
  db.close()
  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
})

const commit = (extra) => commitIngest(db, { camp_id: campId, cohort_id: null, author_user_id: 'u1', device_id: deviceId, mode: 'add', ...extra })

// Three time blocks — enough room for a 3-block span starting at the first
// one, without the MEDIUM #3 overflow clamp kicking in.
const BASE = {
  approved: {
    groups: ['Bunk 1'],
    days_of_operation: ['Friday'],
    time_blocks: ['16:00-16:40', '16:40-17:20', '17:20-18:00'],
    activities: [],
  },
}

const RUACH_SHABBAT = {
  name: 'Ruach & Shabbat', time_block: '16:00-16:40', days: ['Friday'],
  scope: { is_all_groups: true, groups: [] },
  confidence: 'high',
  span_blocks: 3,
}

describe('Slice B — recurring multi-block candidate', () => {
  it('a confirmed recurring candidate writes an anchor_activities row with span_blocks=N', () => {
    const result = commit({ ...BASE, fixedEvents: [RUACH_SHABBAT] })
    expect(result.fixedEvents.created).toBe(1)
    const row = db.prepare("SELECT * FROM anchor_activities WHERE camp_id = ? AND name = 'Ruach & Shabbat'").get(campId)
    expect(row).toBeTruthy()
    expect(row.span_blocks).toBe(3)
  })

  // Governor round 2 — the real-file defect (Group Schedules 1.xlsx: 14
  // groups each showing the same Friday merge must resolve to ONE anchor,
  // not 14). The aggregation itself lives upstream (multiBlockCandidates.js
  // collapses the 14 raw per-group detections into one is_all_groups
  // candidate before this layer ever sees it); this asserts the ingest
  // layer honors that verdict — an is_all_groups:true, one-day fixedEvents
  // entry produces exactly ONE anchor_activities row, never one per group.
  it('an is_all_groups recurring candidate on a camp with MANY groups still writes exactly ONE anchor row', () => {
    const manyGroups = {
      approved: {
        groups: ['Yeladim 1', 'Yeladim 2', 'Tzofim 1', 'Tzofim 2', 'Tzofim 3', 'CITs'],
        days_of_operation: ['Friday'],
        time_blocks: ['16:00-16:40', '16:40-17:20', '17:20-18:00'],
        activities: [],
      },
    }
    const result = commit({ ...manyGroups, fixedEvents: [RUACH_SHABBAT] })
    expect(result.fixedEvents.created).toBe(1)
    const rows = db.prepare("SELECT * FROM anchor_activities WHERE camp_id = ? AND name = 'Ruach & Shabbat'").all(campId)
    expect(rows.length).toBe(1)
    expect(rows[0].span_blocks).toBe(3)
    expect(rows[0].is_all_groups).toBe(1)
  })

  it('an ordinary fixedEvents entry with no span_blocks leaves the column NULL — true no-op, engine treats NULL as 1', () => {
    const swim = { name: 'Swim', time_block: '16:00-16:40', days: ['Friday'], scope: { is_all_groups: true, groups: [] }, confidence: 'high' }
    commit({ ...BASE, fixedEvents: [swim] })
    const row = db.prepare("SELECT * FROM anchor_activities WHERE camp_id = ? AND name = 'Swim'").get(campId)
    expect(row.span_blocks).toBeNull()
  })
})

describe('Slice B — one-off multi-block candidate', () => {
  it('a confirmed one-off candidate writes an events catalog row, no template_slots row', () => {
    const result = commit({
      ...BASE,
      multiBlockEvents: [{ name: 'Mitzvah Project', notes: 'Imported from schedule.xlsx — Friday, 3 blocks starting 16:00' }],
    })
    expect(result.multiBlockEvents.created).toBe(1)
    const row = db.prepare("SELECT * FROM events WHERE camp_id = ? AND name = 'Mitzvah Project'").get(campId)
    expect(row).toBeTruthy()
    expect(row.notes).toBe('Imported from schedule.xlsx — Friday, 3 blocks starting 16:00')
    const slotCount = db.prepare('SELECT COUNT(*) c FROM template_slots').get().c
    expect(slotCount).toBe(0)
  })

  it('dedups two multiBlockEvents entries with the same name within one commit', () => {
    const result = commit({
      ...BASE,
      multiBlockEvents: [
        { name: 'Mitzvah Project', notes: 'first' },
        { name: 'Mitzvah Project', notes: 'second' },
      ],
    })
    expect(result.multiBlockEvents.created).toBe(1)
    const rows = db.prepare("SELECT * FROM events WHERE camp_id = ? AND name = 'Mitzvah Project'").all(campId)
    expect(rows.length).toBe(1)
  })

  it('an unconfirmed candidate (absent from both arrays) writes nothing', () => {
    const result = commit({ ...BASE })
    expect(result.fixedEvents.created).toBe(0)
    expect(result.multiBlockEvents.created).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM anchor_activities').get().c).toBe(0)
    expect(db.prepare('SELECT COUNT(*) c FROM events').get().c).toBe(0)
  })

  // Red Hat HIGH #1 — the recurring path already dedups across re-imports
  // via anchorSlots (T72 recognize-then-skip); the one-off path did not.
  // Confirm the SAME payload twice (two separate commitIngest calls, as a
  // director re-confirming the same candidate on a re-import would) and
  // assert exactly ONE events row, not two.
  it('two commitIngest calls with the same multiBlockEvents payload write exactly ONE events row (cross-import idempotency)', () => {
    const payload = { ...BASE, multiBlockEvents: [{ name: 'Mitzvah Project', notes: 'Imported from schedule.xlsx — Friday, 3 blocks starting 16:00' }] }
    const first = commit(payload)
    expect(first.multiBlockEvents.created).toBe(1)
    const second = commit(payload)
    expect(second.multiBlockEvents.created).toBe(0)
    expect(second.multiBlockEvents.unchanged).toBe(1)
    const rows = db.prepare("SELECT * FROM events WHERE camp_id = ? AND name = 'Mitzvah Project'").all(campId)
    expect(rows.length).toBe(1)
  })
})

describe('Slice B — MEDIUM #3 span overflow clamp', () => {
  // The camp has only 2 time blocks; a span_blocks=3 candidate starting at
  // the FIRST block would walk off the end (buildSchedule.js's tailBlock
  // guard silently drops the out-of-bounds tail) — clamp to what actually
  // remains (2) rather than write a claim the engine can only half-honor.
  it('clamps span_blocks to the number of blocks actually remaining in that day from the start block', () => {
    const twoBlocks = {
      approved: {
        groups: ['Bunk 1'],
        days_of_operation: ['Friday'],
        time_blocks: ['16:00-16:40', '16:40-17:20'],
        activities: [],
      },
    }
    commit({ ...twoBlocks, fixedEvents: [RUACH_SHABBAT] }) // span_blocks:3, only 2 blocks exist
    const row = db.prepare("SELECT * FROM anchor_activities WHERE camp_id = ? AND name = 'Ruach & Shabbat'").get(campId)
    expect(row.span_blocks).toBe(2)
  })

  // Starting at the LAST of three blocks — only 1 block remains — clamps
  // down to 1, which is written as no span_blocks at all (NULL, the same
  // true no-op as an ordinary fixedEvents entry with no span).
  it('clamps all the way to 1 (no span_blocks column written) when the head is the day\'s last block', () => {
    const lastBlockHead = { ...RUACH_SHABBAT, time_block: '17:20-18:00' } // 3rd of 3 blocks in BASE
    commit({ ...BASE, fixedEvents: [lastBlockHead] })
    const row = db.prepare("SELECT * FROM anchor_activities WHERE camp_id = ? AND name = 'Ruach & Shabbat'").get(campId)
    expect(row.span_blocks).toBeNull()
  })

  // A span that fits with room to spare is NOT clamped — the guard is a
  // ceiling, never a floor/rewrite of a value that was already valid.
  it('does not clamp a span that fits within the day\'s remaining blocks', () => {
    commit({ ...BASE, fixedEvents: [RUACH_SHABBAT] }) // span_blocks:3, BASE has exactly 3 blocks, head is the 1st
    const row = db.prepare("SELECT * FROM anchor_activities WHERE camp_id = ? AND name = 'Ruach & Shabbat'").get(campId)
    expect(row.span_blocks).toBe(3)
  })
})
