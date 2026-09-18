// @vitest-environment jsdom
//
// T229 round 2 — AssignmentPanel wiring for H1 (per-solve runId), H3 (commit
// re-entrancy), M1 (a real route off the "not on a schedule yet" dead end),
// M3 (row-count guard on the .txt import branch).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../../localClient', () => ({
  localClient: { commitElectiveRun: vi.fn() },
}))

import AssignmentPanel from './AssignmentPanel.jsx'
import { localClient } from '../../../localClient'

const GROUPS = [{ id: 'grp-1', tier_id: 'tier-juniors' }, { id: 'grp-2', tier_id: 'tier-seniors' }]
const DAYS = [{ id: 'day-1', name: 'Monday' }]
const TIME_BLOCKS = [{ id: 'tb-1', name: 'First Period' }]
const ACTIVITIES = [{ id: 'act-1', name: 'Archery' }]
const SET_ACTIVITIES = [{ id: 'osa-1', elective_set_id: 'set-1', activity_id: 'act-1', status: 'confirmed', capacity_mode: 'unlimited', capacity_limit: null }]
const TEMPLATE_SLOTS = [
  { id: 's1', template_id: 'tpl-1', elective_set_id: 'set-1', day_id: 'day-1', time_block_id: 'tb-1', group_id: 'grp-1' },
]
const SCHEDULE_TEMPLATES = [{ id: 'tpl-1', camp_id: 'camp-1', week_id: null, name: 'Manual', kind: 'manual' }]

function baseProps(overrides = {}) {
  return {
    electiveSetId: 'set-1',
    campId: 'camp-1',
    setActivities: SET_ACTIVITIES,
    activities: ACTIVITIES,
    groups: GROUPS,
    tiers: [{ id: 'tier-juniors', name: 'Juniors' }, { id: 'tier-seniors', name: 'Seniors' }],
    days: DAYS,
    timeBlocks: TIME_BLOCKS,
    templateSlots: TEMPLATE_SLOTS,
    scheduleTemplates: SCHEDULE_TEMPLATES,
    scheduleWeeks: [],
    role: 'admin',
    onError: vi.fn(),
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `run-${crypto.randomUUID.mock?.calls?.length ?? 0}`) })
  localClient.commitElectiveRun.mockReset()
})

describe('AssignmentPanel — M1 empty state offers a real route, not a dead end', () => {
  it('renders a control that navigates to the Schedule screen when the set is not placed', () => {
    const onNavigate = vi.fn()
    render(<AssignmentPanel {...baseProps({ templateSlots: [], onNavigate })} />)
    const button = screen.getByRole('button', { name: /schedule/i })
    fireEvent.click(button)
    expect(onNavigate).toHaveBeenCalledWith('schedule')
  })
})

async function driveToPreview({ file } = {}) {
  const props = baseProps()
  render(<AssignmentPanel {...props} />)
  const input = document.querySelector('input[type="file"]')
  const sheetFile = file ?? new File(['Name\t#1\nAri\tArchery'], 'sheet.txt', { type: 'text/plain' })
  fireEvent.change(input, { target: { files: [sheetFile] } })
  await waitFor(() => expect(screen.getByText(/Confirm Mapping/)).toBeTruthy())
  fireEvent.click(screen.getByText(/Confirm Mapping/))
  await waitFor(() => expect(screen.getByText(/Solve/i)).toBeTruthy())
  fireEvent.click(screen.getByText(/Solve/i))
  await waitFor(() => expect(screen.getByText(/Commit Assignments/)).toBeTruthy())
}

describe('AssignmentPanel — H1 mints a runId per solve and threads it to commit', () => {
  it("commit()'s payload carries a non-empty runId", async () => {
    localClient.commitElectiveRun.mockResolvedValue({ ok: true, runId: 'whatever', counts: { campers: 1 } })
    await driveToPreview()
    fireEvent.click(screen.getByText(/Commit Assignments/))
    await waitFor(() => expect(localClient.commitElectiveRun).toHaveBeenCalled())
    const payload = localClient.commitElectiveRun.mock.calls[0][0]
    expect(typeof payload.runId).toBe('string')
    expect(payload.runId.length).toBeGreaterThan(0)
  })
})

describe('AssignmentPanel — H3 commit re-entrancy', () => {
  it('a second click while committing does not issue a second commitElectiveRun call', async () => {
    let resolveCommit
    localClient.commitElectiveRun.mockImplementation(
      () => new Promise((resolve) => { resolveCommit = resolve })
    )
    await driveToPreview()
    const commitButton = screen.getByText(/Commit Assignments/)
    fireEvent.click(commitButton)
    fireEvent.click(commitButton)
    fireEvent.click(commitButton)
    expect(localClient.commitElectiveRun).toHaveBeenCalledTimes(1)
    resolveCommit({ ok: true, runId: 'r1', counts: { campers: 1 } })
  })
})
