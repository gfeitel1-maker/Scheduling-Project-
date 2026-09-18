// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import AssignmentPreview from './AssignmentPreview'

const OCC = [{ id: 'occ-1', day_id: 'day-1', time_block_id: 'tb-1' }]
const DAYS = [{ id: 'day-1', name: 'Monday' }]
const TBS = [{ id: 'tb-1', name: 'Period 2' }]
const ACTIVITIES = [{ id: 'act-1', name: 'Swim' }]
const CAMPERS = [{ id: 'cam-1', display_name: 'Ari Green' }]

describe('AssignmentPreview', () => {
  it('shows the zero-assignment sub-state with NO Commit button', () => {
    render(
      <AssignmentPreview
        assignments={[]} findings={[]} occurrences={OCC} days={DAYS} timeBlocks={TBS}
        activities={ACTIVITIES} campers={CAMPERS} role="admin" onCommit={vi.fn()} committing={false}
      />
    )
    expect(screen.getByText('No campers could be placed')).not.toBeNull()
    expect(screen.queryByText(/commit/i)).toBeNull()
  })

  it('disables the commit control for a non-admin role', () => {
    const assignments = [{ camper_id: 'cam-1', occurrence_id: 'occ-1', activity_id: 'act-1', preference_rank: 1, flags: [] }]
    render(
      <AssignmentPreview
        assignments={assignments} findings={[]} occurrences={OCC} days={DAYS} timeBlocks={TBS}
        activities={ACTIVITIES} campers={CAMPERS} role="staff" onCommit={vi.fn()} committing={false}
      />
    )
    const btn = screen.getByRole('button', { name: /commit/i })
    expect(btn.disabled).toBe(true)
    expect(btn.getAttribute('title')).toBe('Admin only')
  })

  it('enables the commit control for an admin role with placements', () => {
    const assignments = [{ camper_id: 'cam-1', occurrence_id: 'occ-1', activity_id: 'act-1', preference_rank: 1, flags: [] }]
    render(
      <AssignmentPreview
        assignments={assignments} findings={[]} occurrences={OCC} days={DAYS} timeBlocks={TBS}
        activities={ACTIVITIES} campers={CAMPERS} role="admin" onCommit={vi.fn()} committing={false}
      />
    )
    expect(screen.getByRole('button', { name: /commit/i }).disabled).toBe(false)
  })
})
