import { describe, it, expect, vi } from 'vitest'
import { clearElectivePermissionOnRemoval } from './electivePermissionClear'

function mockRepo() {
  return { writeFields: vi.fn(async () => {}) }
}

function membership(overrides = {}) {
  return { id: 'mem-1', elective_set_id: 'set-1', activity_id: 'act-1', ...overrides }
}

describe('clearElectivePermissionOnRemoval', () => {
  it('clears recurrence_truth_status to null when permission and zero remaining memberships', async () => {
    const repo = mockRepo()
    await clearElectivePermissionOnRemoval({
      repo,
      allMemberships: [membership()],
      removedMembershipIds: ['mem-1'],
      activityId: 'act-1',
      currentStatus: 'permission',
    })
    expect(repo.writeFields).toHaveBeenCalledWith('activities', 'act-1', { recurrence_truth_status: null })
  })

  it('does NOT clear when the activity still belongs to another elective set', async () => {
    const repo = mockRepo()
    await clearElectivePermissionOnRemoval({
      repo,
      allMemberships: [membership({ id: 'mem-1', elective_set_id: 'set-1' }), membership({ id: 'mem-2', elective_set_id: 'set-2' })],
      removedMembershipIds: ['mem-1'],
      activityId: 'act-1',
      currentStatus: 'permission',
    })
    expect(repo.writeFields).not.toHaveBeenCalled()
  })

  it('does NOT clear an asserted status regardless of remaining memberships', async () => {
    const repo = mockRepo()
    await clearElectivePermissionOnRemoval({
      repo,
      allMemberships: [membership()],
      removedMembershipIds: ['mem-1'],
      activityId: 'act-1',
      currentStatus: 'asserted',
    })
    expect(repo.writeFields).not.toHaveBeenCalled()
  })

  it('does NOT clear an obligation status regardless of remaining memberships', async () => {
    const repo = mockRepo()
    await clearElectivePermissionOnRemoval({
      repo,
      allMemberships: [membership()],
      removedMembershipIds: ['mem-1'],
      activityId: 'act-1',
      currentStatus: 'obligation',
    })
    expect(repo.writeFields).not.toHaveBeenCalled()
  })

  it('does NOT clear a null/blank status (nothing to clear)', async () => {
    const repo = mockRepo()
    await clearElectivePermissionOnRemoval({
      repo,
      allMemberships: [membership()],
      removedMembershipIds: ['mem-1'],
      activityId: 'act-1',
      currentStatus: null,
    })
    expect(repo.writeFields).not.toHaveBeenCalled()
  })

  it('excludes removed membership ids correctly from the remaining-count math', async () => {
    const repo = mockRepo()
    // Two memberships for act-1 in the SAME set (shouldn't normally happen,
    // but the math must still hold): removing both leaves zero remaining.
    await clearElectivePermissionOnRemoval({
      repo,
      allMemberships: [membership({ id: 'mem-1' }), membership({ id: 'mem-2' })],
      removedMembershipIds: ['mem-1', 'mem-2'],
      activityId: 'act-1',
      currentStatus: 'permission',
    })
    expect(repo.writeFields).toHaveBeenCalledWith('activities', 'act-1', { recurrence_truth_status: null })
  })

  it('ignores memberships belonging to a different activity when counting remaining', async () => {
    const repo = mockRepo()
    await clearElectivePermissionOnRemoval({
      repo,
      allMemberships: [membership({ id: 'mem-1', activity_id: 'act-1' }), membership({ id: 'mem-2', activity_id: 'act-2' })],
      removedMembershipIds: ['mem-1'],
      activityId: 'act-1',
      currentStatus: 'permission',
    })
    expect(repo.writeFields).toHaveBeenCalledWith('activities', 'act-1', { recurrence_truth_status: null })
  })
})
