// @vitest-environment jsdom
//
// T229 round 2 — AssignmentPanel wiring for H1 (per-solve runId), H3 (commit
// re-entrancy), M1 (a real route off the "not on a schedule yet" dead end),
// M3 (row-count guard on the .txt import branch).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

vi.mock('../../../localClient', () => ({
  localClient: { commitElectiveRun: vi.fn(), getSecurityStatus: vi.fn() },
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
  localClient.getSecurityStatus.mockReset()
  // Default for the pre-existing suites: encryption OFF, which is the real
  // default today (SHORESH_AT_REST_ENCRYPTION is unset). T249's own suite sets
  // this per test.
  localClient.getSecurityStatus.mockResolvedValue({ atRestEncryptionEnabled: false })
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

// ---------------------------------------------------------------------------
// T249 -- the D8 at-rest-encryption gate. These are the pin the ticket exists
// for: the owner's ruling (ADR 2026-09-23, Q4) is that real camper data stays
// refused at a VISIBLE, TESTED gate until encryption ships, and a gate nobody
// tests is a promise. Each test below corresponds to one way this could rot
// back into a promise while still looking implemented.
// ---------------------------------------------------------------------------

const DISCLOSURE = /not yet encrypted at rest/i

async function disclosure() {
  return await screen.findByTestId('encryption-disclosure')
}

describe('T249 -- the encryption disclosure renders whenever encryption is not active', () => {
  it('states it in the entry ("No run") state when the status read says false', async () => {
    render(<AssignmentPanel {...baseProps()} />)
    const row = await disclosure()
    expect(row.getAttribute('data-encryption-state')).toBe('unencrypted')
    expect(row.textContent).toMatch(DISCLOSURE)
    expect(row.textContent).toMatch(/Do not use real camper names/i)
  })

  it('renders a neutral CHECKING row rather than nothing while the async read is in flight', async () => {
    // DESIGN_STANDARD 5b: the read is an async IPC call, and "silently absent
    // until it resolves" is absent exactly when the screen is first looked at.
    let resolveStatus
    localClient.getSecurityStatus.mockImplementation(() => new Promise((r) => { resolveStatus = r }))
    render(<AssignmentPanel {...baseProps()} />)
    const row = await disclosure()
    expect(row.getAttribute('data-encryption-state')).toBe('checking')
    resolveStatus({ atRestEncryptionEnabled: false })
    await waitFor(() => expect(screen.getByTestId('encryption-disclosure').getAttribute('data-encryption-state')).toBe('unencrypted'))
  })

  it('is also present on the "not on a schedule yet" entry state', async () => {
    render(<AssignmentPanel {...baseProps({ templateSlots: [] })} />)
    expect((await disclosure()).textContent).toMatch(DISCLOSURE)
  })
})

describe('T249 -- it survives the director-flow state transitions, not just the first render', () => {
  it('is still present after import -> mapping -> solve -> preview, and after returning to the entry state', async () => {
    render(<AssignmentPanel {...baseProps()} />)
    expect((await disclosure()).textContent).toMatch(DISCLOSURE)

    const input = document.querySelector('input[type="file"]')
    fireEvent.change(input, { target: { files: [new File(['Name\t#1\nAri\tArchery'], 'sheet.txt', { type: 'text/plain' })] } })

    // mapping
    await waitFor(() => expect(screen.getByText(/Confirm Mapping/)).toBeTruthy())
    expect(screen.getByTestId('encryption-disclosure').textContent).toMatch(DISCLOSURE)

    // parsed -> preview
    fireEvent.click(screen.getByText(/Confirm Mapping/))
    await waitFor(() => expect(screen.getByText(/Solve/i)).toBeTruthy())
    expect(screen.getByTestId('encryption-disclosure').textContent).toMatch(DISCLOSURE)
    fireEvent.click(screen.getByText(/Solve/i))
    await waitFor(() => expect(screen.getByText(/Commit Assignments/)).toBeTruthy())
    expect(screen.getByTestId('encryption-disclosure').textContent).toMatch(DISCLOSURE)

    // committed
    localClient.commitElectiveRun.mockResolvedValue({ ok: true, runId: 'r1', counts: { campers: 1 } })
    fireEvent.click(screen.getByText(/Commit Assignments/))
    await waitFor(() => expect(screen.getByText(/Assign Another Sheet/i)).toBeTruthy())
    expect(screen.getByTestId('encryption-disclosure').textContent).toMatch(DISCLOSURE)

    // ...and back round to the entry state
    fireEvent.click(screen.getByText(/Assign Another Sheet/i))
    await waitFor(() => expect(screen.getByText(/Import Camper Preferences/i)).toBeTruthy())
    expect(screen.getByTestId('encryption-disclosure').textContent).toMatch(DISCLOSURE)
  })
})

describe('T249 -- it REFUSES, rather than merely renders', () => {
  it('cannot be dismissed: the disclosure contains no control of any kind', async () => {
    const row = await (async () => { render(<AssignmentPanel {...baseProps()} />); return disclosure() })()
    expect(within(row).queryAllByRole('button')).toHaveLength(0)
    expect(row.querySelectorAll('button, a, input, [role="button"]')).toHaveLength(0)
  })

  it('FAILS CLOSED when the status read throws -- an unreadable status is not evidence of encryption', async () => {
    localClient.getSecurityStatus.mockRejectedValue(new Error('IPC transport failure'))
    render(<AssignmentPanel {...baseProps()} />)
    const row = await waitFor(async () => {
      const r = await disclosure()
      expect(r.getAttribute('data-encryption-state')).toBe('unencrypted')
      return r
    })
    expect(row.textContent).toMatch(DISCLOSURE)
    // The failure is surfaced, not swallowed (describeWriteFailure, standing rule).
    expect(row.textContent).toMatch(/could not be read/i)
  })

  it('FAILS CLOSED on a malformed/absent payload -- only a literal true clears the gate', async () => {
    for (const payload of [undefined, null, {}, { atRestEncryptionEnabled: 'true' }, { atRestEncryptionEnabled: 1 }]) {
      localClient.getSecurityStatus.mockResolvedValue(payload)
      const { unmount } = render(<AssignmentPanel {...baseProps()} />)
      const row = await disclosure()
      expect(row.getAttribute('data-encryption-state')).toBe('unencrypted')
      unmount()
    }
  })
})

describe('T249 -- and once encryption is actually on, it stops warning without over-claiming', () => {
  it('drops the warning but still states what the flag does NOT cover', async () => {
    // Red Hat's finding: `return null` here would say "this camper's name is
    // encrypted on disk", which the flag does not establish. Two gaps outlive
    // the flip -- data written before it, and a peer syncing with it off -- so
    // the neutral row names them instead of implying they are closed.
    localClient.getSecurityStatus.mockResolvedValue({ atRestEncryptionEnabled: true })
    render(<AssignmentPanel {...baseProps()} />)
    const row = await disclosure()
    expect(row.getAttribute('data-encryption-state')).toBe('encrypted')
    expect(row.textContent).not.toMatch(/Do not use real camper names/i)
    expect(row.textContent).toMatch(/before it was enabled/i)
    expect(row.textContent).toMatch(/peer device/i)
    // Still nothing to click, in this state either.
    expect(within(row).queryAllByRole('button')).toHaveLength(0)
  })
})

// T299 — the panel's own grid path, which nothing in this file reached before.
//
// WHY THAT MATTERS MORE THAN THE ASSERTIONS. Every case above drives a
// row-per-camper sheet, so the planner-grid branch — the one that produces an
// unattributed subject, and the one this ticket's defect lived in — was never
// entered through the panel at all. That is the same blind spot that let the grid
// path ship broken once already: a suite can be large and still never open the door
// the director opens.
describe("AssignmentPanel — a planner grid's subject is scoped to the import it arrived in", () => {
  // A planner ABOVE a ranked block, which is the grid shape this panel can actually
  // reach — see the limit recorded at the bottom of this describe. The grid rows
  // carry no name, so they are one unattributed subject; the ranked block names Ari
  // and gives the mapping the name and rank columns the confirm gate demands.
  const SHEET = [
    '\tMonday\tTuesday',
    'Period 1\tArchery\tSwim',
    'Period 2\tSwim\tArchery',
    'Name\t#1',
    'Ari\tArchery',
  ].join('\n')
  const PROPS = { activities: [{ id: 'act-1', name: 'Archery' }, { id: 'act-2', name: 'Swim' }] }

  async function uploadAndCommit(fileName) {
    render(<AssignmentPanel {...baseProps(PROPS)} />)
    const input = document.querySelector('input[type="file"]')
    fireEvent.change(input, { target: { files: [new File([SHEET], fileName, { type: 'text/plain' })] } })
    await waitFor(() => expect(screen.getByText(/Confirm Mapping/)).toBeTruthy())
    fireEvent.click(screen.getByText(/Confirm Mapping/))
    await waitFor(() => expect(screen.getByText(/Solve/i)).toBeTruthy())
    fireEvent.click(screen.getByText(/Solve/i))
    await waitFor(() => expect(screen.getByText(/Commit Assignments/)).toBeTruthy())
    fireEvent.click(screen.getByText(/Commit Assignments/))
    await waitFor(() => expect(localClient.commitElectiveRun).toHaveBeenCalled())
    const { parsed } = localClient.commitElectiveRun.mock.calls.at(-1)[0]
    return parsed.campers.find((c) => c.is_unattributed === 1)
  }

  it('gives two uploads of a byte-identical sheet two different subjects', async () => {
    localClient.commitElectiveRun.mockResolvedValue({ ok: true, runId: 'r', counts: { campers: 2 } })

    // Both children exported from the same template, so even the filename matches —
    // the collision that made the filename unusable as a key in the first place.
    const first = await uploadAndCommit('planner.txt')
    const second = await uploadAndCommit('planner.txt')

    // The two sheets really are indistinguishable by content. Asserted rather than
    // assumed: if the fixture drifted, the case below would pass for the wrong
    // reason and prove nothing.
    expect(first).toBeTruthy()
    expect(second.external_id).toBe(first.external_id)

    // ...and they are still two campers. This is the whole ticket, through the
    // panel's own file input rather than through a helper that imitates it.
    expect(second.id).not.toBe(first.id)
  })

  // A WHOLE-SHEET planner (no ranked block at all) CANNOT be imported here, and
  // that is a pre-existing defect this ticket found rather than caused. The confirm
  // gate is `mapping.nameIndex != null && rankColumns.length > 0`
  // (MappingCorrector.jsx), and a child's own planner has neither by design — the
  // identity comes from the submission, and the cells ARE the ranks. So the button
  // never enables and the director cannot get past the mapping screen.
  //
  // Confirmed by execution: driving a whole-sheet grid through this same flow leaves
  // the panel on the mapping screen with onError never called, because nothing was
  // ever clicked. It is not covered by test/panelImportPath.test.js either — that
  // file's `importThroughPanelPath` calls readPreferenceSheet directly and so never
  // renders this gate, which is exactly why the gap survived.
  //
  // Left unfixed deliberately: what the mapping screen should show for a sheet with
  // no name and no rank columns is a product question, not a wiring one.
  it('leaves a whole-sheet planner stuck at the mapping gate (documented gap, not a fix)', async () => {
    render(<AssignmentPanel {...baseProps(PROPS)} />)
    const input = document.querySelector('input[type="file"]')
    const grid = '\tMonday\tTuesday\nPeriod 1\tArchery\tSwim\nPeriod 2\tSwim\tArchery'
    fireEvent.change(input, { target: { files: [new File([grid], 'planner.txt', { type: 'text/plain' })] } })
    const confirm = await screen.findByRole('button', { name: /Confirm Mapping/ })
    expect(confirm.disabled).toBe(true)
  })
})
