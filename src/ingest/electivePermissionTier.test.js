import { describe, it, expect, vi } from 'vitest'
import { markElectivePermissionTier } from './electivePermissionTier'

function mockRepo() {
  return { writeFields: vi.fn(async () => {}) }
}

describe('markElectivePermissionTier', () => {
  it('writes recurrence_truth_status: permission when current status is null', async () => {
    const repo = mockRepo()
    await markElectivePermissionTier(repo, 'act-1', null)
    expect(repo.writeFields).toHaveBeenCalledWith('activities', 'act-1', { recurrence_truth_status: 'permission' })
  })

  it('writes permission when current status is undefined (freshly-minted activity)', async () => {
    const repo = mockRepo()
    await markElectivePermissionTier(repo, 'act-1', undefined)
    expect(repo.writeFields).toHaveBeenCalledWith('activities', 'act-1', { recurrence_truth_status: 'permission' })
  })

  // Non-destructive: an existing Asserted/Obligation truth (e.g. "Swim" is a
  // fixed daily block AND reused as an elective) is LEFT INTACT. The single
  // recurrence_truth_status column can't hold both truths; collapsing to
  // 'permission' would silently destroy the Asserted/Obligation evidence on a
  // synced column with no clear-on-removal path. Coexistence is modeled by the
  // two-rows split (owner priority #5), not by this writer.
  it('does NOT overwrite a prior obligation classification (non-destructive)', async () => {
    const repo = mockRepo()
    await markElectivePermissionTier(repo, 'act-1', 'obligation')
    expect(repo.writeFields).not.toHaveBeenCalled()
  })

  it('does NOT overwrite a prior asserted classification (non-destructive)', async () => {
    const repo = mockRepo()
    await markElectivePermissionTier(repo, 'act-1', 'asserted')
    expect(repo.writeFields).not.toHaveBeenCalled()
  })

  it('is idempotent: writes nothing when already permission', async () => {
    const repo = mockRepo()
    await markElectivePermissionTier(repo, 'act-1', 'permission')
    expect(repo.writeFields).not.toHaveBeenCalled()
  })
})
