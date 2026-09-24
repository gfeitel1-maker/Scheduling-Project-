import { describe, it, expect } from 'vitest'
import { deriveElectiveRunOuterSnapshotId } from './deriveElectiveRunOuterSnapshotId.js'

// T243 — the id is the uniqueness invariant for elective_run_outer_snapshots
// (one row per run/camper/day/block). Two devices independently exporting the
// same finalized run must derive the SAME id for the same cell, or the merge
// keeps two rows.

describe('deriveElectiveRunOuterSnapshotId', () => {
  it('is deterministic: same inputs produce identical ids across calls', () => {
    const a = deriveElectiveRunOuterSnapshotId('run-1', 'camper-1', 'day-1', 'block-1')
    const b = deriveElectiveRunOuterSnapshotId('run-1', 'camper-1', 'day-1', 'block-1')
    expect(a).toBe(b)
  })

  it('changes when run_id differs', () => {
    const a = deriveElectiveRunOuterSnapshotId('run-1', 'camper-1', 'day-1', 'block-1')
    const b = deriveElectiveRunOuterSnapshotId('run-2', 'camper-1', 'day-1', 'block-1')
    expect(a).not.toBe(b)
  })

  it('changes when camper_id differs', () => {
    const a = deriveElectiveRunOuterSnapshotId('run-1', 'camper-1', 'day-1', 'block-1')
    const b = deriveElectiveRunOuterSnapshotId('run-1', 'camper-2', 'day-1', 'block-1')
    expect(a).not.toBe(b)
  })

  it('changes when day_id differs', () => {
    const a = deriveElectiveRunOuterSnapshotId('run-1', 'camper-1', 'day-1', 'block-1')
    const b = deriveElectiveRunOuterSnapshotId('run-1', 'camper-1', 'day-2', 'block-1')
    expect(a).not.toBe(b)
  })

  it('changes when time_block_id differs', () => {
    const a = deriveElectiveRunOuterSnapshotId('run-1', 'camper-1', 'day-1', 'block-1')
    const b = deriveElectiveRunOuterSnapshotId('run-1', 'camper-1', 'day-1', 'block-2')
    expect(a).not.toBe(b)
  })

  it('rejects a non-opaque component (raw free text)', () => {
    expect(() => deriveElectiveRunOuterSnapshotId('run 1', 'camper-1', 'day-1', 'block-1')).toThrow(
      /component/i
    )
  })

  it('rejects an empty component', () => {
    expect(() => deriveElectiveRunOuterSnapshotId('', 'camper-1', 'day-1', 'block-1')).toThrow(
      /component/i
    )
  })
})
