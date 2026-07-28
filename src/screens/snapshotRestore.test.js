import { describe, it, expect } from 'vitest'
import {
  hasPayload,
  isRestorable,
  unrestorableReason,
  unrestorableMessage,
  parseSnapshotPayload,
  UNRESTORABLE_MISSING,
  UNRESTORABLE_NO_PAYLOAD,
  UNRESTORABLE_UNREADABLE,
} from './snapshotRestore'

// T8 — snapshots saved before af6a9d8 have NULL slots/overlays because the
// boolean `is_auto` threw at the bind, so every field after it in key order was
// never written. Restoring one silently did nothing.

const good = {
  id: 's1',
  name: 'Before regen',
  slots: JSON.stringify([{ group_id: 'g1', day_id: 'd1', time_block_id: 't1', activity_id: 'a1', flags: {} }]),
  overlays: JSON.stringify([{ unit_id: 'u1', day_id: 'd1', from_block_order: 1, to_block_order: 2, label: 'Trip' }]),
}

// Exactly the shape of the three rows found in the production DB.
const deadRow = { id: 's2', name: 'Auto-save', slots: null, overlays: null }

describe('hasPayload', () => {
  it('accepts a snapshot whose slots column holds JSON text', () => {
    expect(hasPayload(good)).toBe(true)
  })

  it('rejects the NULL-slots rows written before the bind fix', () => {
    expect(hasPayload(deadRow)).toBe(false)
  })

  it('rejects undefined and empty-string payloads', () => {
    expect(hasPayload({ id: 's3' })).toBe(false)
    expect(hasPayload({ id: 's4', slots: '' })).toBe(false)
  })

  it('accepts a snapshot of a deliberately empty schedule', () => {
    // '[]' is a real snapshot of an empty grid, not a failed write. Treating it
    // as unrestorable would block a legitimate "clear everything" undo.
    expect(hasPayload({ id: 's5', slots: '[]' })).toBe(true)
  })
})

describe('unrestorableReason', () => {
  it('reports a missing snapshot distinctly from an empty one', () => {
    // The whole T8 defect was collapsing these two into one silent return.
    expect(unrestorableReason(undefined)).toBe(UNRESTORABLE_MISSING)
    expect(unrestorableReason(deadRow)).toBe(UNRESTORABLE_NO_PAYLOAD)
  })

  it('returns null for a restorable snapshot', () => {
    expect(unrestorableReason(good)).toBeNull()
  })
})

describe('isRestorable', () => {
  it('agrees with unrestorableReason', () => {
    for (const s of [good, deadRow, undefined, { id: 'x', slots: '' }]) {
      expect(isRestorable(s)).toBe(unrestorableReason(s) === null)
    }
  })
})

describe('unrestorableMessage', () => {
  it('always returns non-empty director-facing text', () => {
    for (const r of [UNRESTORABLE_MISSING, UNRESTORABLE_NO_PAYLOAD, UNRESTORABLE_UNREADABLE, 'unknown']) {
      expect(unrestorableMessage(r).length).toBeGreaterThan(0)
    }
  })

  it('never leaks implementation detail to the director', () => {
    // Tester evaluates as a camp director who does not know what a column is.
    const all = [UNRESTORABLE_MISSING, UNRESTORABLE_NO_PAYLOAD, UNRESTORABLE_UNREADABLE].map(unrestorableMessage).join(' ')
    for (const jargon of ['slots', 'null', 'NULL', 'column', 'op-log', 'af6a9d8', 'JSON', 'bind']) {
      expect(all).not.toContain(jargon)
    }
  })
})

describe('parseSnapshotPayload', () => {
  it('round-trips slots and overlays in the shape saveSnapshot writes', () => {
    const result = parseSnapshotPayload(good)
    expect(result.ok).toBe(true)
    expect(result.slots).toHaveLength(1)
    expect(result.slots[0].activity_id).toBe('a1')
    expect(result.overlays[0].label).toBe('Trip')
  })

  it('treats a snapshot with no overlays as having an empty overlay list', () => {
    const result = parseSnapshotPayload({ ...good, overlays: null })
    expect(result.ok).toBe(true)
    expect(result.overlays).toEqual([])
  })

  it('refuses a dead row with a specific reason rather than throwing', () => {
    expect(parseSnapshotPayload(deadRow)).toEqual({ ok: false, reason: UNRESTORABLE_NO_PAYLOAD })
  })

  it('reports unreadable JSON instead of throwing into the click handler', () => {
    expect(parseSnapshotPayload({ id: 's6', slots: '{not json' })).toEqual({ ok: false, reason: UNRESTORABLE_UNREADABLE })
  })

  it('rejects a payload that parses but is not a list of slots', () => {
    expect(parseSnapshotPayload({ id: 's7', slots: '{"group_id":"g1"}' })).toEqual({ ok: false, reason: UNRESTORABLE_UNREADABLE })
  })
})
