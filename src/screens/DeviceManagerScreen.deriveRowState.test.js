// T332 fold-in (Red Hat HIGH, Art. V — never show the director a tidy lie). Unit-tests the PURE
// derivation (deriveDeviceRowState) that maps a device-list row's `effectiveState` (computed
// server-side from the real camp_authority_log replay, electron/main.js's listDevices) to the
// badge/affordance this screen renders — without rendering React at all. The live screen's visual
// result is the Tester's job; this file is about the mapping being right for every state.
import { describe, it, expect } from 'vitest'
import { deriveDeviceRowState } from './DeviceManagerScreen.jsx'

describe('deriveDeviceRowState', () => {
  it('an ordinary device (no effectiveState) keeps the original revoked_at-only logic', () => {
    const active = deriveDeviceRowState({ authorized_at: '2026-01-01', revoked_at: null }, { role: 'admin', canManage: true })
    expect(active).toMatchObject({ removalPending: false, isRevoked: false, isAuthorized: true, canVote: false })

    const revoked = deriveDeviceRowState({ authorized_at: '2026-01-01', revoked_at: '2026-02-01' }, { role: 'admin', canManage: true })
    expect(revoked).toMatchObject({ removalPending: false, isRevoked: true, isAuthorized: false, canVote: false })
  })

  it('an admin/founder row with effectiveState "active" shows Active, not a vote affordance for itself', () => {
    const self = deriveDeviceRowState(
      { authorized_at: '2026-01-01', effectiveState: 'active', isSelf: true, hasVoted: false },
      { role: 'admin', canManage: true }
    )
    expect(self).toMatchObject({ removalPending: false, isRevoked: false, isAuthorized: true, canVote: false })
  })

  it('removal_pending shows the badge, the pluralized detail line, and never "Removed"', () => {
    const twoNeeded = deriveDeviceRowState(
      { authorized_at: '2026-01-01', effectiveState: 'removal_pending', votesNeeded: 2, votesCast: 1, isSelf: false, hasVoted: false },
      { role: 'admin', canManage: true }
    )
    expect(twoNeeded.removalPending).toBe(true)
    expect(twoNeeded.isRevoked).toBe(false)
    expect(twoNeeded.detailText).toBe('Needs 1 more director to confirm')
    expect(twoNeeded.canVote).toBe(true)

    const threeNeeded = deriveDeviceRowState(
      { authorized_at: '2026-01-01', effectiveState: 'removal_pending', votesNeeded: 3, votesCast: 0, isSelf: false, hasVoted: false },
      { role: 'admin', canManage: true }
    )
    expect(threeNeeded.detailText).toBe('Needs 3 more directors to confirm')

    const noCounts = deriveDeviceRowState(
      { authorized_at: '2026-01-01', effectiveState: 'removal_pending', isSelf: false, hasVoted: false },
      { role: 'admin', canManage: true }
    )
    expect(noCounts.detailText).toBe('Removal pending — waiting on other directors')
  })

  it('the admin who already voted sees no vote affordance', () => {
    const voted = deriveDeviceRowState(
      { authorized_at: '2026-01-01', effectiveState: 'removal_pending', votesNeeded: 2, votesCast: 1, isSelf: false, hasVoted: true },
      { role: 'admin', canManage: true }
    )
    expect(voted.canVote).toBe(false)
  })

  it('the target device itself never gets a vote affordance against its own removal', () => {
    const selfTarget = deriveDeviceRowState(
      { authorized_at: '2026-01-01', effectiveState: 'active', isSelf: true, hasVoted: false },
      { role: 'admin', canManage: true }
    )
    expect(selfTarget.canVote).toBe(false)
  })

  it('a non-admin viewer, or canManage=false (Client), never gets a vote affordance', () => {
    const staff = deriveDeviceRowState(
      { authorized_at: '2026-01-01', effectiveState: 'removal_pending', votesNeeded: 2, votesCast: 1, isSelf: false, hasVoted: false },
      { role: 'staff', canManage: true }
    )
    expect(staff.canVote).toBe(false)

    const clientMode = deriveDeviceRowState(
      { authorized_at: '2026-01-01', effectiveState: 'removal_pending', votesNeeded: 2, votesCast: 1, isSelf: false, hasVoted: false },
      { role: 'admin', canManage: false }
    )
    expect(clientMode.canVote).toBe(false)
  })

  it('effectiveState "removed" renders as Removed, never a vote affordance', () => {
    const removed = deriveDeviceRowState(
      { authorized_at: '2026-01-01', revoked_at: '2026-02-01', effectiveState: 'removed', isSelf: false, hasVoted: false },
      { role: 'admin', canManage: true }
    )
    expect(removed).toMatchObject({ removalPending: false, isRevoked: true, isAuthorized: false, canVote: false })
  })
})
