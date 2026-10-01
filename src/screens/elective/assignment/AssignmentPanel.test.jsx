// @vitest-environment jsdom
//
// T229 round 2 — AssignmentPanel wiring for H1 (per-solve runId), H3 (commit
// re-entrancy), M1 (a real route off the "not on a schedule yet" dead end),
// M3 (row-count guard on the .txt import branch).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'

vi.mock('../../../localClient', () => ({
  localClient: {
    commitElectiveRun: vi.fn(), getSecurityStatus: vi.fn(),
    // T312 — the recall read and the remember write. Both are best-effort in the
    // panel, so the pre-existing suites leave them at their defaults: `list`
    // resolving empty is a camp that has remembered nothing, which is what every
    // one of those tests means to exercise.
    list: vi.fn(), rememberColumnMapping: vi.fn(),
    // T250 A3 — the run list and its own read, exercised by the cold-open
    // hydration suite below. Every other suite in this file leaves these
    // unset (RunList itself renders nothing on an empty resolve).
    listElectiveRuns: vi.fn(), getElectiveRun: vi.fn(), setElectiveAssignment: vi.fn(),
  },
}))

import AssignmentPanel from './AssignmentPanel.jsx'
import { localClient } from '../../../localClient'
import { deriveCamperId } from '../../../../electron/ops/electiveDerivedIds.js'

const GROUPS = [{ id: 'grp-1', tier_id: 'tier-juniors' }, { id: 'grp-2', tier_id: 'tier-seniors' }]
const DAYS = [{ id: 'day-1', name: 'Monday' }]
// tb-2 is in the camp's catalog but never placed on the fixture schedule
// below (TEMPLATE_SLOTS has only one slot, at tb-1) — deliberate, so a T301
// bundle naming it as a member period is a legal "not part of this run" case
// (ADR D5), not a malformed fixture.
const TIME_BLOCKS = [{ id: 'tb-1', name: 'First Period' }, { id: 'tb-2', name: 'Second Period' }]
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
  localClient.list.mockReset()
  localClient.list.mockResolvedValue([])
  localClient.rememberColumnMapping.mockReset()
  localClient.rememberColumnMapping.mockResolvedValue({ ok: true, id: 'seed-1' })
  localClient.listElectiveRuns.mockReset().mockResolvedValue([])
  localClient.getElectiveRun.mockReset()
  localClient.setElectiveAssignment.mockReset().mockResolvedValue({ ok: true })
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

async function driveToPreview({ file, extraProps = {} } = {}) {
  const props = baseProps(extraProps)
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

// T316 — a confirmed offering declared 'limited' with a blank capacity
// resolves to `resolveOfferingCapacity`'s `unknownLimit`. Before this ticket
// that became capacity 0 and the offering silently closed; the run must
// instead refuse to solve, name the offering, and never reach commit.
describe('AssignmentPanel — T316 a blank limited capacity refuses the run', () => {
  it('surfaces the finding, shows no Commit button, and never calls commitElectiveRun', async () => {
    const props = baseProps({
      setActivities: [{
        id: 'osa-1', elective_set_id: 'set-1', activity_id: 'act-1',
        status: 'confirmed', capacity_mode: 'limited', capacity_limit: null,
      }],
    })
    render(<AssignmentPanel {...props} />)
    const input = document.querySelector('input[type="file"]')
    const sheetFile = new File(['Name\t#1\nAri\tArchery'], 'sheet.txt', { type: 'text/plain' })
    fireEvent.change(input, { target: { files: [sheetFile] } })
    await waitFor(() => expect(screen.getByText(/Confirm Mapping/)).toBeTruthy())
    fireEvent.click(screen.getByText(/Confirm Mapping/))
    await waitFor(() => expect(screen.getByText(/Solve/i)).toBeTruthy())
    fireEvent.click(screen.getByText(/Solve/i))

    await waitFor(() => expect(screen.getByText(/is set to limited capacity/)).toBeTruthy())
    expect(screen.queryByText(/Commit Assignments/)).toBeNull()
    expect(localClient.commitElectiveRun).not.toHaveBeenCalled()
  })
})

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

describe('AssignmentPanel — T319 names the commit after the import event, not a date-only string', () => {
  it("commit()'s payload name is the import-event form, with sheetCount = parsed.campers.length", async () => {
    localClient.commitElectiveRun.mockResolvedValue({ ok: true, runId: 'whatever', counts: { campers: 1 } })
    // driveToPreview's default sheet has exactly one camper row ("Ari"), so the
    // shared formatter must read `parsed.campers.length` === 1 through THIS door,
    // the same way the CLI door reads it from its own `parsed`.
    await driveToPreview()
    fireEvent.click(screen.getByText(/Commit Assignments/))
    await waitFor(() => expect(localClient.commitElectiveRun).toHaveBeenCalled())
    const payload = localClient.commitElectiveRun.mock.calls[0][0]
    expect(payload.name).toMatch(/^Import \d{4}-\d{2}-\d{2} \d{2}:\d{2}, 1 sheet$/)
    expect(payload.parsed.campers).toHaveLength(1)
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

  // T305 replaces the guard that used to sit here. It asserted the Confirm button
  // stayed DISABLED for a whole-sheet planner and was correct at the time: the gap
  // was real and deliberately left unfixed pending an owner decision. That decision
  // (2026-09-29) is "land it and say what was read", so the assertion is inverted
  // rather than deleted -- the T305 describe below is its replacement.
})

describe('T305 -- a sheet that is nothing but a planner grid imports', () => {
  const PROPS = { activities: [{ id: 'act-1', name: 'Archery' }, { id: 'act-2', name: 'Swim' }] }

  // No camper-name column and no rank columns, BY DESIGN (ADR 14.1a): this is one
  // child's own sheet, the identity comes from the submission, and the cells ARE the
  // ranks. Exactly the file the old gate refused.
  const PLANNER = [
    '\tMonday\tTuesday',
    'Period 1\tArchery\tSwim',
    'Period 2\tSwim\tArchery',
  ].join('\n')

  function upload(sheet, fileName = 'planner.txt') {
    render(<AssignmentPanel {...baseProps(PROPS)} />)
    const input = document.querySelector('input[type="file"]')
    fireEvent.change(input, { target: { files: [new File([sheet], fileName, { type: 'text/plain' })] } })
  }

  it('reaches the parsed phase with NO mapping screen', async () => {
    upload(PLANNER)
    // The transform already knows how to read this, so there is nothing to ask.
    await waitFor(() => expect(screen.getByText(/Solve/i)).toBeTruthy())
    expect(screen.queryByText(/Confirm Mapping/)).toBeNull()
  })

  it('lands ONE unattributed subject carrying its per-cell preferences', async () => {
    localClient.commitElectiveRun.mockResolvedValue({ ok: true, runId: 'r', counts: { campers: 1 } })
    upload(PLANNER)
    await waitFor(() => expect(screen.getByText(/Solve/i)).toBeTruthy())
    fireEvent.click(screen.getByText(/Solve/i))
    await waitFor(() => expect(screen.getByText(/Commit Assignments/)).toBeTruthy())
    fireEvent.click(screen.getByText(/Commit Assignments/))
    await waitFor(() => expect(localClient.commitElectiveRun).toHaveBeenCalled())

    const { parsed } = localClient.commitElectiveRun.mock.calls.at(-1)[0]
    const subjects = parsed.campers.filter((c) => c.is_unattributed === 1)
    expect(subjects).toHaveLength(1)
    // The DATA, not just the row: four filled cells across two days x two periods.
    // Asserting the row alone would pass for a subject that landed carrying nothing.
    expect(parsed.preferences.length).toBe(4)
    // And the app SAYS so, which is the half of the owner's ruling that is not the
    // unblocking -- "land it and say what was read".
    expect(parsed.residue.some((r) => r.kind === 'UNATTRIBUTED_SUBJECT')).toBe(true)
  })

  // THE CASES THAT PROVE THE GATE WAS NARROWED, NOT REMOVED. Without these, a patch
  // that simply deletes the confirm gate passes every other test in this file.
  // detectGridLayout requires TWO day-named columns AND a period-labelled body row;
  // each fixture below fails exactly one of those and must still be asked about.
  it.each([
    ['no name, no ranks, no grid at all', 'Alpha\tBeta\nx\ty'],
    ['only one day column', '\tMonday\nPeriod 1\tArchery'],
    ['day columns but no period labels', '\tMonday\tTuesday\nx\tArchery\tSwim'],
  ])('still shows the mapping screen for a sheet with %s', async (_label, sheet) => {
    upload(sheet, 'not-a-planner.txt')
    const confirm = await screen.findByRole('button', { name: /Confirm Mapping/ })
    expect(confirm.disabled).toBe(true)
  })
})

describe("T307 -- the director's column correction is what gets imported", () => {
  const PROPS = {
    activities: [
      { id: 'act-1', name: 'Archery' },
      { id: 'act-2', name: 'Swim' },
      { id: 'act-3', name: 'Ceramics' },
    ],
  }

  // THE WHOLE SUITE DRIVES THE RENDERED CORRECTOR, and that is the point rather than
  // a style choice. test/panelImportPath.test.js calls readPreferenceSheet directly,
  // so it exercised the transform with a mapping the panel never actually sends --
  // which is how a corrector that changed nothing stayed green.
  function uploadSheet(sheet, fileName = 'prefs.txt') {
    render(<AssignmentPanel {...baseProps(PROPS)} />)
    const input = document.querySelector('input[type="file"]')
    fireEvent.change(input, { target: { files: [new File([sheet], fileName, { type: 'text/plain' })] } })
    return screen.findByRole('button', { name: /Confirm Mapping/ })
  }

  // Confirm -> Solve -> Commit, returning what the commit was actually handed. The
  // payload rather than the screen: a preview that renders the right thing while the
  // commit carries the old reading is precisely the failure being fixed.
  async function commitAndReadPayload() {
    fireEvent.click(screen.getByText(/Confirm Mapping/))
    await waitFor(() => expect(screen.getByText(/Solve/i)).toBeTruthy())
    fireEvent.click(screen.getByText(/Solve/i))
    await waitFor(() => expect(screen.getByText(/Commit Assignments/)).toBeTruthy())
    fireEvent.click(screen.getByText(/Commit Assignments/))
    await waitFor(() => expect(localClient.commitElectiveRun).toHaveBeenCalled())
    return localClient.commitElectiveRun.mock.calls.at(-1)[0].parsed
  }

  beforeEach(() => {
    localClient.commitElectiveRun.mockResolvedValue({ ok: true, runId: 'r', counts: { campers: 1 } })
  })

  // A REAL ROSTER SHAPE: the legal name and the name the camp actually calls them.
  // `Camper` matches the name pattern and `Goes By` does not, so the inferencer picks
  // column A -- correctly, on the evidence it has, and not what this camp meant.
  const GOES_BY = ['Camper\tGoes By\t#1', 'Rivka Stern\tRivi\tArchery'].join('\n')

  it('imports names from the column the director picked, not the inferred one', async () => {
    await uploadSheet(GOES_BY)
    fireEvent.change(screen.getByLabelText(/Camper name/), { target: { value: '1' } })
    const parsed = await commitAndReadPayload()
    expect(parsed.campers.map((c) => c.display_name)).toEqual(['Rivi'])
  })

  it('stops calling the remapped column unread, and starts saying so about the one it replaced', async () => {
    await uploadSheet(GOES_BY)
    fireEvent.change(screen.getByLabelText(/Camper name/), { target: { value: '1' } })
    const parsed = await commitAndReadPayload()
    const unread = parsed.residue.filter((r) => r.kind === 'UNRECOGNISED_COLUMN').map((r) => r.header)
    // Both halves matter. The first is the false claim an un-normalised override
    // makes -- a column reported unread that the director just mapped. The second is
    // the true claim that must survive: column A really is unread now.
    expect(unread).not.toContain('Goes By')
    expect(unread).toContain('Camper')
  })

  // THE DEAD END. An ordinary camp's column names, which the inferencer does not
  // recognise as ranks. The screen tells the director to add rank columns, they do,
  // Confirm enables -- and before this ticket the import answered "does not read as a
  // camper preference sheet" and wrote nothing.
  const PICK_AB = ['Camper\tPick A\tPick B', 'Ari Katz\tArchery\tSwim'].join('\n')

  it('imports a sheet whose rank columns only the director can name', async () => {
    await uploadSheet(PICK_AB)
    fireEvent.click(screen.getByText(/Add Rank Column/))
    fireEvent.change(screen.getByLabelText('Rank #1'), { target: { value: '1' } })
    fireEvent.click(screen.getByText(/Add Rank Column/))
    fireEvent.change(screen.getByLabelText('Rank #2'), { target: { value: '2' } })

    const parsed = await commitAndReadPayload()
    expect(parsed.campers.map((c) => c.display_name)).toEqual(['Ari Katz'])
    expect(parsed.preferences.map((p) => [p.label, p.rank])).toEqual([['Archery', 1], ['Swim', 2]])
  })

  // TWO READINGS OF ONE SHEET AT ONCE. parsePreferenceSheet is ADDITIVE across
  // shapes -- rankColumns, invertedMatrix, longFormat and tiedColumns each push
  // cells, with no precedence. inferPreferenceMapping keeps them apart by GATING
  // (an inverted matrix is only proposed when no rank columns were found), and an
  // override that carries a director's rank column past that gate has the sheet read
  // both ways: Ceramics at rank 1 from the director, Archery at rank 1 from the
  // matrix. The override is normalised against the same gate rather than trusted raw.
  const MATRIX_PLUS_PICK = ['Camper\tArchery\tSwim\tTop Pick', 'Ari Katz\t1\t2\tCeramics'].join('\n')

  it('reads an inverted matrix the director overrode ONE way, not both', async () => {
    await uploadSheet(MATRIX_PLUS_PICK)
    fireEvent.click(screen.getByText(/Add Rank Column/))
    fireEvent.change(screen.getByLabelText('Rank #1'), { target: { value: '3' } })

    const parsed = await commitAndReadPayload()
    expect(parsed.preferences.map((p) => [p.label, p.rank])).toEqual([['Ceramics', 1]])
  })

  // AN INVERTED MATRIX CARRIES ITS RANKS IN ITS CELLS, so it has no rank columns to
  // count -- and the confirm gate used to demand one. A director could only get past
  // it by adding a dummy rank column, which was harmless while the mapping was
  // discarded and destroys the read now that it is honoured: supplying rank columns
  // is exactly what closes the inverted-matrix gate. The gate asks the transform
  // instead, so this sheet is confirmable as it stands.
  const MATRIX_ONLY = ['Camper\tArchery\tSwim', 'Ari Katz\t1\t2'].join('\n')

  it('confirms an inverted matrix without making the director invent a rank column', async () => {
    const confirm = await uploadSheet(MATRIX_ONLY)
    expect(confirm.disabled).toBe(false)

    const parsed = await commitAndReadPayload()
    expect(parsed.preferences.map((p) => [p.label, p.rank])).toEqual([['Archery', 1], ['Swim', 2]])
  })

  // THE CORRECTOR REFUSES WHAT INFERENCE CANNOT PRODUCE. Two ranks on one column and
  // a rank on the name column are both unreachable by inference and both reachable by
  // a director; refused here, where the sample rows are still on screen, rather than
  // landing as a double-read or a row of campers named after an activity.
  it('will not confirm two ranks pointed at one column', async () => {
    const confirm = await uploadSheet(PICK_AB)
    fireEvent.click(screen.getByText(/Add Rank Column/))
    fireEvent.change(screen.getByLabelText('Rank #1'), { target: { value: '1' } })
    fireEvent.click(screen.getByText(/Add Rank Column/))
    fireEvent.change(screen.getByLabelText('Rank #2'), { target: { value: '1' } })
    expect(confirm.disabled).toBe(true)
  })

  it('will not confirm a rank pointed at the camper-name column', async () => {
    const confirm = await uploadSheet(PICK_AB)
    fireEvent.click(screen.getByText(/Add Rank Column/))
    fireEvent.change(screen.getByLabelText('Rank #1'), { target: { value: '0' } })
    expect(confirm.disabled).toBe(true)
  })
})

// T301 slice 3 — deriveChoices' output must actually reach
// buildElectiveAssignments (`choices` + `choiceOfferings`, neither passed by
// anything in production before this). A fixture where the bundle simply
// places a camper is NOT a reliable proof: with no capacity contention,
// tier 2 alone (the pre-existing, unlinked pass) would place the same camper
// in the same periods anyway, since repeats are normal in this engine — so a
// "camper landed in both periods" assertion would pass identically whether
// or not this wiring exists. The reliable signal is one only tier 1 can
// produce: UNSUPPORTED_LINKED_CHOICE, emitted when a bundle's own member
// period fails to resolve to an occurrence this run derived (ADR D5, case
// (a)) — unreachable at all unless choiceOfferings reached the engine, and
// its rendered text unreachable in the REAL name unless the derived choices
// also reached AssignmentPreview's `choices` prop (T300's
// findingDisplayMessage). One assertion, both halves of the wiring.
describe('AssignmentPanel — T301 slice 3: bundle choices reach the solver', () => {
  it('surfaces UNSUPPORTED_LINKED_CHOICE naming the bundle by its director-given name', async () => {
    await driveToPreview({
      extraProps: {
        bundles: [{ id: 'bundle-1', elective_set_id: 'set-1', activity_id: 'act-1', name: 'Archery', scope_mode: 'all' }],
        bundlePeriods: [
          { bundle_id: 'bundle-1', day_id: 'day-1', time_block_id: 'tb-1' },
          // Never placed on TEMPLATE_SLOTS — see TIME_BLOCKS' own comment.
          { bundle_id: 'bundle-1', day_id: 'day-1', time_block_id: 'tb-2' },
        ],
        bundleTiers: [],
      },
    })
    expect(screen.getByText(/“Archery” is meant to be taken as a set/)).toBeTruthy()
  })
})

describe('T312 -- a mapping this camp confirmed before comes back filled in', () => {
  const PROPS = { activities: [{ id: 'act-1', name: 'Archery' }, { id: 'act-2', name: 'Swim' }] }
  // The sheet from T307: headers no inferencer recognises as ranks.
  const SHEET = ['Camper\tBunk\tPick A\tPick B', 'Ari Katz\tAleph\tArchery\tSwim'].join('\n')

  // What the camp confirmed last week, as it is stored: header TEXT, no indices.
  const REMEMBERED = {
    id: 'seed-1', kind: 'preference_column_roles', status: 'active',
    match_key: 'hdr-whatever',
    payload: JSON.stringify({
      name: 'Camper', externalId: null, division: 'Bunk',
      ranks: [{ rank: 1, header: 'Pick A' }, { rank: 2, header: 'Pick B' }],
    }),
  }

  function upload(sheet = SHEET) {
    render(<AssignmentPanel {...baseProps(PROPS)} />)
    fireEvent.change(document.querySelector('input[type="file"]'), {
      target: { files: [new File([sheet], 'prefs.txt', { type: 'text/plain' })] },
    })
  }

  it('fills the corrector in and says where it came from', async () => {
    localClient.list.mockResolvedValue([REMEMBERED])
    upload()
    const confirm = await screen.findByRole('button', { name: /Confirm Mapping/ })
    // THE WHOLE POINT: readable on arrival, with no dropdown touched.
    expect(confirm.disabled).toBe(false)
    expect(screen.getByLabelText('Rank #1').value).toBe('2')
    expect(screen.getByLabelText('Rank #2').value).toBe('3')
    expect(screen.getByText(/Filled in from the last time you imported this form/)).toBeTruthy()
  })

  it('imports what the remembered mapping says', async () => {
    localClient.list.mockResolvedValue([REMEMBERED])
    localClient.commitElectiveRun.mockResolvedValue({ ok: true, runId: 'r', counts: { campers: 1 } })
    upload()
    await screen.findByRole('button', { name: /Confirm Mapping/ })
    fireEvent.click(screen.getByText(/Confirm Mapping/))
    await waitFor(() => expect(screen.getByText(/Solve/i)).toBeTruthy())
    fireEvent.click(screen.getByText(/Solve/i))
    await waitFor(() => expect(screen.getByText(/Commit Assignments/)).toBeTruthy())
    fireEvent.click(screen.getByText(/Commit Assignments/))
    await waitFor(() => expect(localClient.commitElectiveRun).toHaveBeenCalled())

    const { parsed } = localClient.commitElectiveRun.mock.calls.at(-1)[0]
    expect(parsed.campers.map((c) => c.display_name)).toEqual(['Ari Katz'])
    expect(parsed.preferences.map((p) => [p.label, p.rank])).toEqual([['Archery', 1], ['Swim', 2]])
  })

  // DRIFT. The camp renamed one column between imports, which is P38's exact
  // shape -- and a binding that applied its surviving half would drop rank 2 for
  // every camper with ok=true. It must not pre-fill at all.
  // `Backup`, not `Second Choice`: the latter IS a header the inferencer reads as
  // a rank, so that sheet is legitimately confirmable and would have passed this
  // test for a reason that has nothing to do with the recall. Found by the test
  // failing and the fixture being wrong rather than the code.
  it('does not fill in a sheet that renamed a remembered column', async () => {
    localClient.list.mockResolvedValue([REMEMBERED])
    upload(['Camper\tBunk\tPick A\tBackup', 'Ari Katz\tAleph\tArchery\tSwim'].join('\n'))
    const confirm = await screen.findByRole('button', { name: /Confirm Mapping/ })
    // Nothing was recalled, so this is the un-remembered state: no ranks, no note.
    expect(confirm.disabled).toBe(true)
    expect(screen.queryByText(/Filled in from the last time/)).toBeNull()
    expect(screen.queryByLabelText('Rank #1')).toBeNull()
  })

  it('remembers a hand-built mapping on confirm, by header text', async () => {
    localClient.list.mockResolvedValue([])
    upload()
    await screen.findByRole('button', { name: /Confirm Mapping/ })
    fireEvent.click(screen.getByText(/Add Rank Column/))
    fireEvent.change(screen.getByLabelText('Rank #1'), { target: { value: '2' } })
    fireEvent.click(screen.getByText(/Add Rank Column/))
    fireEvent.change(screen.getByLabelText('Rank #2'), { target: { value: '3' } })
    fireEvent.click(screen.getByText(/Confirm Mapping/))

    await waitFor(() => expect(localClient.rememberColumnMapping).toHaveBeenCalled())
    const { matchKey, payload } = localClient.rememberColumnMapping.mock.calls.at(-1)[0]
    expect(matchKey).toMatch(/^hdr-/)
    expect(payload.ranks).toEqual([{ rank: 1, header: 'Pick A' }, { rank: 2, header: 'Pick B' }])
    // No cell value reaches the store (ADR 6.0) -- this table replicates.
    expect(JSON.stringify(payload)).not.toMatch(/Ari|Aleph|Archery|Swim/)
  })

  // A memo must never be able to fail an import that already succeeded.
  it('still imports when remembering throws', async () => {
    localClient.list.mockResolvedValue([])
    localClient.rememberColumnMapping.mockImplementation(() => { throw new Error('no such channel') })
    localClient.commitElectiveRun.mockResolvedValue({ ok: true, runId: 'r', counts: { campers: 1 } })
    upload()
    await screen.findByRole('button', { name: /Confirm Mapping/ })
    fireEvent.click(screen.getByText(/Add Rank Column/))
    fireEvent.change(screen.getByLabelText('Rank #1'), { target: { value: '2' } })
    fireEvent.click(screen.getByText(/Confirm Mapping/))
    await waitFor(() => expect(screen.getByText(/Solve/i)).toBeTruthy())
  })

  // A recall read that fails is a camp that has remembered nothing, not a
  // broken import.
  it('still imports when the recall read throws', async () => {
    localClient.list.mockRejectedValue(new Error('db unavailable'))
    upload()
    const confirm = await screen.findByRole('button', { name: /Confirm Mapping/ })
    expect(confirm.disabled).toBe(true)
    expect(screen.queryByText(/Filled in from the last time/)).toBeNull()
  })
})

// T314 — A WORKBOOK WITH MORE THAN ONE TAB, driven through the RENDERED panel.
//
// These exist separately from `test/panelWorkbookTabs.test.js` on purpose, and the reason is the
// defect T313 recorded: that file MIRRORS the panel's flow (read, select, parse, commit) rather than
// driving it, so it cannot catch the panel wiring the selection up wrongly — only the rule being
// wrong. This block drives the real file input with real .xlsx bytes and asserts on what reaches
// `localClient.commitElectiveRun`.
//
// Owner ruling 2026-09-29: "a director who has two tabs on an import won't get their thing read.
// that is fucking absurd. and should be a fix."
describe('T314 — the panel reads the tab that holds the preferences', () => {
  const PROPS = {
    activities: [
      { id: 'act-1', name: 'Archery' }, { id: 'act-2', name: 'Swim' },
      { id: 'act-3', name: 'Ceramics' }, { id: 'act-4', name: 'Nature' },
    ],
  }

  const TABLE = [
    ['Camper Name', '#1', '#2'],
    ['Ari Feldspar', 'Swim', 'Archery'],
    ['Noa Quartzite', 'Ceramics', 'Nature'],
  ]
  // An offerings MENU: the same day x period shape as one camper's filled planner, which is why
  // reading tab 1 blindly minted a camper out of it.
  const MENU = [['Period', 'Monday', 'Tuesday'], ['Period 1', 'Swim', 'Archery']]
  const NOTES = [['Please return by June 1']]

  async function workbookBytes(tabs) {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    for (const [name, aoa] of tabs) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name)
    return XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
  }

  async function uploadWorkbook(tabs) {
    localClient.getSecurityStatus.mockResolvedValue({ atRestEncryptionEnabled: false })
    localClient.commitElectiveRun.mockResolvedValue({ ok: true, runId: 'r', counts: { campers: 2 } })
    const bytes = await workbookBytes(tabs)
    render(<AssignmentPanel {...baseProps(PROPS)} />)
    const input = document.querySelector('input[type="file"]')
    fireEvent.change(input, {
      target: { files: [new File([bytes], 'book.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })] },
    })
  }

  /** Drive all the way to commit and return the payload the panel actually sent. */
  async function committedPayload() {
    await waitFor(() => expect(screen.getByText(/Confirm Mapping/)).toBeTruthy())
    fireEvent.click(screen.getByText(/Confirm Mapping/))
    await waitFor(() => expect(screen.getByText(/Solve/i)).toBeTruthy())
    fireEvent.click(screen.getByText(/Solve/i))
    await waitFor(() => expect(screen.getByText(/Commit Assignments/)).toBeTruthy())
    fireEvent.click(screen.getByText(/Commit Assignments/))
    await waitFor(() => expect(localClient.commitElectiveRun).toHaveBeenCalled())
    return localClient.commitElectiveRun.mock.calls.at(-1)[0]
  }

  it('a cover tab first and the table on tab 2: the table is what imports', async () => {
    await uploadWorkbook([['Read Me', NOTES], ['Preferences', TABLE]])
    const { parsed } = await committedPayload()
    expect(parsed.campers.map((c) => c.display_name).sort()).toEqual(['Ari Feldspar', 'Noa Quartzite'])
  })

  it('an offerings menu first does not become a phantom camper named after the file', async () => {
    await uploadWorkbook([['Offerings', MENU], ['Preferences', TABLE]])
    const { parsed } = await committedPayload()
    expect(parsed.campers.map((c) => c.display_name).sort()).toEqual(['Ari Feldspar', 'Noa Quartzite'])
    // The shape of the old failure, asserted directly: one unattributed row called `book`.
    expect(parsed.campers.filter((c) => c.is_unattributed === 1)).toEqual([])
    expect(parsed.campers.map((c) => c.display_name)).not.toContain('book')
  })

  it('tells the director which tabs it did not read', async () => {
    await uploadWorkbook([['Read Me', NOTES], ['Preferences', TABLE], ['Signatures', NOTES]])
    await waitFor(() => expect(screen.getByText(/Confirm Mapping/)).toBeTruthy())
    fireEvent.click(screen.getByText(/Confirm Mapping/))
    await waitFor(() => expect(screen.getByText(/Solve/i)).toBeTruthy())
    // Rendered, not merely present in an object — this is the half the director sees.
    expect(screen.getByText(/Tab .Read Me./)).toBeTruthy()
    expect(screen.getByText(/Tab .Signatures./)).toBeTruthy()
  })

  it('a single-tab workbook says nothing about unread tabs', async () => {
    // NON-VACUITY for the assertion above.
    await uploadWorkbook([['Preferences', TABLE]])
    await waitFor(() => expect(screen.getByText(/Confirm Mapping/)).toBeTruthy())
    fireEvent.click(screen.getByText(/Confirm Mapping/))
    await waitFor(() => expect(screen.getByText(/Solve/i)).toBeTruthy())
    expect(screen.queryByText(/Tab ./)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// T250 A5 — the same-name refusal must be visible and must BLOCK, even when
// this set is placed on more than one candidate schedule. Before this fix the
// route-chooser branch (candidateTemplateIds.length > 1 && !templateId) ran
// BEFORE the refusal check, so its buttons called chooseTemplateAndSolve
// directly and a same-name sheet solved anyway.
// ---------------------------------------------------------------------------
describe('AssignmentPanel — T250 A5: same-name refusal blocks the route chooser', () => {
  // A second template placing the same elective set, so candidateTemplateIds
  // has more than one entry — the exact combination the evidence
  // (docs/work/evidence/T251/01-blocked-import-NOT-refused-route-chooser.png)
  // shows skipping the refusal entirely.
  const TWO_TEMPLATE_SLOTS = [
    ...TEMPLATE_SLOTS,
    { id: 's2', template_id: 'tpl-2', elective_set_id: 'set-1', day_id: 'day-1', time_block_id: 'tb-1', group_id: 'grp-1' },
  ]
  const TWO_TEMPLATES = [
    ...SCHEDULE_TEMPLATES,
    { id: 'tpl-2', camp_id: 'camp-1', week_id: null, name: 'Generated', kind: 'generated' },
  ]

  // Header/rows shape from src/ingest/preferenceSheet.test.js's own same-name
  // fixture: two rows naming one child with no camper id to tell them apart.
  // Every ranked label must resolve against the camp's OWN activity catalog
  // for the collision to fire (parsePreferenceSheet's slot-overlap rule
  // treats a row with zero resolved activities as "empty", which only
  // collides against a second empty row) — so this set's activities carry
  // every label the sheet ranks, not just the baseProps() default of one.
  const SAME_NAME_ACTIVITIES = [
    { id: 'act-1', name: 'Archery' }, { id: 'act-2', name: 'Gaga' },
    { id: 'act-3', name: 'Sailing' }, { id: 'act-4', name: 'Ceramics' },
  ]
  const SAME_NAME_SHEET =
    'Camper Name\tDivision\tSwim Alternative (Y/N)\t#1\t#2\t#3\tAdditional Comments\n' +
    'Ari Green\tArad\tN\tArchery\tGaga\tSailing\t\n' +
    'Ari Green\tBogrim\tN\tCeramics\tSailing\tGaga\t'

  it('shows the refusal card, not the route chooser, and never offers a Solve affordance', async () => {
    const props = baseProps({ templateSlots: TWO_TEMPLATE_SLOTS, scheduleTemplates: TWO_TEMPLATES, activities: SAME_NAME_ACTIVITIES })
    render(<AssignmentPanel {...props} />)
    const input = document.querySelector('input[type="file"]')
    const sheetFile = new File([SAME_NAME_SHEET], 'sheet.tsv', { type: 'text/tab-separated-values' })
    fireEvent.change(input, { target: { files: [sheetFile] } })
    await waitFor(() => expect(screen.getByText(/Confirm Mapping/)).toBeTruthy())
    fireEvent.click(screen.getByText(/Confirm Mapping/))

    // The refusal, not the route chooser.
    await waitFor(() => expect(screen.getByText(/This sheet can.t be assigned yet/)).toBeTruthy())
    expect(screen.queryByText(/choose which to assign against/)).toBeNull()
    expect(screen.queryByText('Generated')).toBeNull()
    expect(screen.queryByText('Manual')).toBeNull()

    // No solve affordance anywhere — only the escape hatch back to file choice.
    expect(screen.queryByText(/^Solve/i)).toBeNull()
    expect(screen.getByRole('button', { name: /Choose a Different File/i })).toBeTruthy()
  })

  it('renders the refusal as an alert and never calls commitElectiveRun even if a director keeps clicking', async () => {
    const props = baseProps({ templateSlots: TWO_TEMPLATE_SLOTS, scheduleTemplates: TWO_TEMPLATES, activities: SAME_NAME_ACTIVITIES })
    render(<AssignmentPanel {...props} />)
    const input = document.querySelector('input[type="file"]')
    const sheetFile = new File([SAME_NAME_SHEET], 'sheet.tsv', { type: 'text/tab-separated-values' })
    fireEvent.change(input, { target: { files: [sheetFile] } })
    await waitFor(() => expect(screen.getByText(/Confirm Mapping/)).toBeTruthy())
    fireEvent.click(screen.getByText(/Confirm Mapping/))

    const card = await screen.findByRole('alert')
    expect(card.textContent).toMatch(/This sheet can.t be assigned yet/)
    expect(localClient.commitElectiveRun).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// T250 A3 — a run opened cold from the run list can be regenerated. Before
// this, onRegenerate was `undefined` unless viewRun.id === committedInfo?.runId
// — only true in the SAME session that solved it, so a cold open had no
// regenerate at all, however stale the run.
// ---------------------------------------------------------------------------
describe('AssignmentPanel — T250 A3: cold-open hydration and regenerate', () => {
  const COLD_RUN = {
    id: 'cold-run-1', name: 'Cold Run', status: 'draft', source_filename: 'sheet.csv',
    schedule_template_id: 'tpl-1', schedule_week_id: null, tier_id: 'tier-juniors',
  }

  function coldRunState() {
    return {
      rows: [{ id: 'asn-1', occurrence_id: 'occ-1', camper_id: 'camper-1', activity_id: 'act-1', preference_rank: 1, camper_name: 'Ari', source: 'solver', is_locked: 0 }],
      occurrences: [{ id: 'occ-1', elective_set_id: 'set-1', day_id: 'day-1', time_block_id: 'tb-1', tier_id: 'tier-juniors' }],
      preferences: [{ id: 'pref-1', camper_id: 'camper-1', choice_id: 'choice-1', occurrence_id: 'occ-1', rank: 1, rank_kind: 'cell-choice', coordinate: null }],
      choices: [{ id: 'choice-1', label: 'Archery', is_linked: 0 }],
      campers: [{ id: 'camper-1', display_name: 'Ari', division_label: null, group_id: 'grp-1', external_id: null, is_unattributed: 0, group_name: 'Cabin One' }],
      staleCount: 1,
      finalizedAgainstStaleGeneration: false,
      overCapacityOccurrences: [],
    }
  }

  it('hydrates the panel session state on cold open, so a regenerate control becomes available', async () => {
    localClient.listElectiveRuns.mockResolvedValue([COLD_RUN])
    localClient.getElectiveRun.mockResolvedValue(coldRunState())
    render(<AssignmentPanel {...baseProps()} />)
    fireEvent.click(await screen.findByTestId('run-list-row-cold-run-1'))

    // Before hydration lands, no regenerate control (a control that cannot
    // work must not render) — after it lands, the staleness offer's button
    // is present.
    const offer = await screen.findByTestId('run-staleness-offer')
    expect(within(offer).getByRole('button', { name: /Re-derive and regenerate/i })).toBeTruthy()
    // T320 part 2 item 3 — the disclosure note: the roster is the SHEET's own,
    // including a camper who ranked nothing and was placed nowhere.
    expect(screen.getByTestId('run-cold-regenerate-note').textContent).toMatch(
      /reconsiders every camper this run's sheet named — including anyone with no ranked choice and no placement/
    )
  })

  it('a cold regenerate re-solves and commits onto the ORIGINAL runId, never a freshly minted one', async () => {
    localClient.listElectiveRuns.mockResolvedValue([COLD_RUN])
    localClient.getElectiveRun.mockResolvedValue(coldRunState())
    localClient.commitElectiveRun.mockResolvedValue({ ok: true, runId: 'cold-run-1', counts: { campers: 1, choices: 1, preferences: 1, assignments: 1 }, findings: [] })
    render(<AssignmentPanel {...baseProps()} />)
    fireEvent.click(await screen.findByTestId('run-list-row-cold-run-1'))

    const offer = await screen.findByTestId('run-staleness-offer')
    fireEvent.click(within(offer).getByRole('button', { name: /Re-derive and regenerate/i }))

    // Solve runs, landing on the preview with a Commit button.
    await waitFor(() => expect(screen.getByText(/Commit Assignments/)).toBeTruthy())
    fireEvent.click(screen.getByText(/Commit Assignments/))

    await waitFor(() => expect(localClient.commitElectiveRun).toHaveBeenCalled())
    const payload = localClient.commitElectiveRun.mock.calls.at(-1)[0]
    expect(payload.runId).toBe('cold-run-1')
  })

  // Round 2 FIX 1 (Code Reviewer, HIGH) — leaving a cold-opened run via "Back
  // to Runs" left templateId (and runId/parsed/occurrences/hydratedRunId)
  // hydrated in this panel's state. Importing a NEW sheet afterwards does not
  // reset templateId, so the route-chooser gate
  // (candidateTemplateIds.length > 1 && !templateId) read templateId as
  // already set and skipped straight past the chooser — silently assigning
  // the new sheet to the COLD RUN's template instead of letting the director
  // pick a route. That violates the standing rule that neither candidate
  // schedule is canonical and nothing may choose one on the director's
  // behalf.
  it('leaving a cold-opened run clears hydrated state, so a later import with >1 candidate template still shows the route chooser', async () => {
    localClient.listElectiveRuns.mockResolvedValue([COLD_RUN])
    localClient.getElectiveRun.mockResolvedValue(coldRunState())
    const TWO_TEMPLATE_SLOTS = [
      ...TEMPLATE_SLOTS,
      { id: 's2', template_id: 'tpl-2', elective_set_id: 'set-1', day_id: 'day-1', time_block_id: 'tb-1', group_id: 'grp-1' },
    ]
    const TWO_TEMPLATES = [
      ...SCHEDULE_TEMPLATES,
      { id: 'tpl-2', camp_id: 'camp-1', week_id: null, name: 'Generated', kind: 'generated' },
    ]
    render(<AssignmentPanel {...baseProps({ templateSlots: TWO_TEMPLATE_SLOTS, scheduleTemplates: TWO_TEMPLATES })} />)

    // Cold-open the draft run, so hydration lands and sets templateId.
    fireEvent.click(await screen.findByTestId('run-list-row-cold-run-1'))
    await screen.findByTestId('run-staleness-offer')

    // Leave the run.
    fireEvent.click(screen.getByRole('button', { name: /Back to Runs/i }))

    // Import a fresh sheet placed on both candidate templates.
    const input = document.querySelector('input[type="file"]')
    const sheetFile = new File(['Name\t#1\nBen\tArchery'], 'sheet2.txt', { type: 'text/plain' })
    fireEvent.change(input, { target: { files: [sheetFile] } })
    await waitFor(() => expect(screen.getByText(/Confirm Mapping/)).toBeTruthy())
    fireEvent.click(screen.getByText(/Confirm Mapping/))

    // The route chooser must render — not a silent solve against the cold
    // run's template.
    await waitFor(() => expect(screen.getByText(/choose which to assign against/)).toBeTruthy())
    expect(screen.queryByText(/^Solve/i)).toBeNull()
  })
})

// Board item 9b — THE PANEL DOOR, on both things it owes.
describe('AssignmentPanel — the camper identity resolver and the bundle catalogue', () => {
  // #670's roster fill, now routed through makeCamperIdentityResolver rather
  // than an inline merge. The observable is DIVISION_ROSTER_MISMATCH: Ari's
  // sheet says Juniors and the camp's roster puts them in grp-2, which is a
  // Seniors group. That finding is reachable ONLY through branch 1 of
  // buildAttendance, which needs a group_id — and the sheet resolved none, so
  // the roster is the only place it can come from.
  const SHEET = new File(['Name\tDivision\t#1\nAri\tJuniors\tArchery'], 'sheet.txt', { type: 'text/plain' })

  // The roster row's id must be the one the PARSER derives for this camper —
  // the merge is by id, so a hand-picked literal would test nothing and pass
  // for the wrong reason.
  const ARI_ID = deriveCamperId('camp-1', { displayName: 'Ari' })

  it("fills a camper's group from the roster, so the sheet/roster disagreement is surfaced", async () => {
    // Driven by hand rather than through driveToPreview: an unplaced camper is
    // the whole point here, and driveToPreview waits for a Commit control that a
    // run placing nobody does not necessarily offer.
    render(<AssignmentPanel {...baseProps({
      campers: [{ id: ARI_ID, display_name: 'Ari', group_id: 'grp-2', division_label: null }],
    })} />)
    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [SHEET] } })
    await waitFor(() => expect(screen.getByText(/Confirm Mapping/)).toBeTruthy())
    fireEvent.click(screen.getByText(/Confirm Mapping/))
    await waitFor(() => expect(screen.getByText(/Solve/i)).toBeTruthy())
    fireEvent.click(screen.getByText(/Solve/i))
    await waitFor(() => expect(screen.getByText(/but the camp has them in/)).toBeTruthy())
  })

  it('a bundle-named label resolves through this door too, not only the CLI', async () => {
    // The catalogue is what turns a bundle's director-given name into a
    // rankable label. Without it the sheet's "Ropes Intensive" is
    // UNRESOLVED_CHOICE_LABEL residue and never reaches the solver at all.
    localClient.commitElectiveRun.mockResolvedValue({ ok: true, runId: 'r', counts: { campers: 1 } })
    await driveToPreview({
      file: new File(['Name\t#1\nAri\tRopes Intensive'], 'sheet.txt', { type: 'text/plain' }),
      extraProps: {
        catalogBundleNames: ['Ropes Intensive'],
        bundles: [{ id: 'bundle-1', elective_set_id: 'set-1', activity_id: 'act-1', name: 'Ropes Intensive', scope_mode: 'all' }],
        bundlePeriods: [{ bundle_id: 'bundle-1', day_id: 'day-1', time_block_id: 'tb-1' }],
        bundleTiers: [],
      },
    })
    fireEvent.click(screen.getByText(/Commit Assignments/))
    await waitFor(() => expect(localClient.commitElectiveRun).toHaveBeenCalled())
    const { parsed } = localClient.commitElectiveRun.mock.calls[0][0]
    expect(parsed.preferences.map((p) => p.label)).toEqual(['Ropes Intensive'])
    expect(parsed.residue?.filter((r) => r.kind === 'UNRESOLVED_CHOICE_LABEL') ?? []).toEqual([])
  })
})

// Board item i-declared-camper-dropped-when-all-choices-outside-catalog. The
// route chooser (candidateTemplateIds.length > 1 && !templateId) lets a
// director solve WITHOUT ever seeing ParseSummary, so the finding has to be
// repeated above the route list — otherwise a declared camper with no
// recognisable choice is imported silently on this path.
describe('AssignmentPanel — route chooser surfaces a declared camper with no recognisable choice', () => {
  const TWO_TEMPLATE_SLOTS = [
    ...TEMPLATE_SLOTS,
    { id: 's2', template_id: 'tpl-2', elective_set_id: 'set-1', day_id: 'day-1', time_block_id: 'tb-1', group_id: 'grp-1' },
  ]
  const TWO_TEMPLATES = [
    ...SCHEDULE_TEMPLATES,
    { id: 'tpl-2', camp_id: 'camp-1', week_id: null, name: 'Generated', kind: 'generated' },
  ]

  it('names the camper above the route list, keyed by their external id', async () => {
    const props = baseProps({ templateSlots: TWO_TEMPLATE_SLOTS, scheduleTemplates: TWO_TEMPLATES })
    render(<AssignmentPanel {...props} />)
    const input = document.querySelector('input[type="file"]')
    const sheetFile = new File(
      ['Camper ID\tCamper Name\t#1\nCM-1\tBen Stone\tRobotics'],
      'sheet.tsv',
      { type: 'text/tab-separated-values' }
    )
    fireEvent.change(input, { target: { files: [sheetFile] } })
    await waitFor(() => expect(screen.getByText(/Confirm Mapping/)).toBeTruthy())
    fireEvent.click(screen.getByText(/Confirm Mapping/))

    await waitFor(() => expect(screen.getByText(/choose which to assign against/)).toBeTruthy())
    expect(screen.getByText(/1 camper\(s\) had no recognisable choice: Ben Stone/)).toBeTruthy()
  })
})

// ---------------------------------------------------------------------------
// FOLD-IN 1 plumbing — `regeneratePending`.
//
// "Regenerate is not available YET" and "regenerate is not available" are
// different facts, and the Draft screen says which. The flag is DERIVED from
// the hydration condition rather than stored, so these pin the derivation.
// ---------------------------------------------------------------------------
describe('AssignmentPanel — regeneratePending while a cold-opened run hydrates', () => {
  const COLD_RUN = {
    id: 'pending-run-1', name: 'Pending Run', status: 'draft', source_filename: 'sheet.csv',
    schedule_template_id: 'tpl-1', schedule_week_id: null, tier_id: 'tier-juniors',
  }
  const STATE = {
    rows: [], occurrences: [], preferences: [], choices: [],
    campers: [], staleCount: 0, finalizedAgainstStaleGeneration: false, overCapacityOccurrences: [],
  }

  // BOTH reads go through the same `getElectiveRun` mock: DraftRunView's own
  // useRunState read (child effect, fires FIRST) and the panel's hydration read
  // (parent effect, fires second). The fixtures below key off that order,
  // because the panel's read is the only one `regeneratePending` describes.
  it('says PREPARING while the hydration read is in flight, and stops once it settles', async () => {
    let resolveHydration
    localClient.listElectiveRuns.mockResolvedValue([COLD_RUN])
    let call = 0
    localClient.getElectiveRun.mockImplementation(() => {
      call += 1
      if (call === 1) return Promise.resolve(STATE)
      return new Promise((r) => { resolveHydration = r })
    })
    render(<AssignmentPanel {...baseProps()} />)
    fireEvent.click(await screen.findByTestId('run-list-row-pending-run-1'))

    const note = await screen.findByTestId('run-regenerate-unavailable')
    expect(note.textContent).toBe('Preparing this run so it can be regenerated…')
    expect(screen.queryByTestId('run-regenerate')).toBeNull()

    resolveHydration(STATE)
    await waitFor(() => expect(screen.getByTestId('run-regenerate')).toBeTruthy())
    expect(screen.queryByTestId('run-regenerate-unavailable')).toBeNull()
  })

  it('stops saying PREPARING when the read never settles, rather than waiting forever', async () => {
    // Red Hat L2 — the read has no timeout of its own, so an unresponsive main
    // process (exactly the condition this branch exists for) left the note at
    // "Preparing this run so it can be regenerated…" indefinitely, having
    // REPLACED a definite, actionable sentence with an indefinite one.
    localClient.listElectiveRuns.mockResolvedValue([COLD_RUN])
    let call = 0
    localClient.getElectiveRun.mockImplementation(() => {
      call += 1
      if (call === 1) return Promise.resolve(STATE)
      return new Promise(() => {})
    })
    // Fake timers BEFORE render: the timer is scheduled inside the hydration
    // effect, so installing them afterwards would leave a real pending timer
    // that no amount of advancing reaches.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      render(<AssignmentPanel {...baseProps()} />)
      fireEvent.click(await screen.findByTestId('run-list-row-pending-run-1'))
      const note = await screen.findByTestId('run-regenerate-unavailable')
      expect(note.textContent).toBe('Preparing this run so it can be regenerated…')

      await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
      const text = screen.getByTestId('run-regenerate-unavailable').textContent
      expect(text).toContain('taking longer than expected')
      expect(text).toContain('go back to Runs and open it again')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops saying PREPARING when the hydration read FAILS, and reports it once', async () => {
    const onError = vi.fn()
    localClient.listElectiveRuns.mockResolvedValue([COLD_RUN])
    let call = 0
    localClient.getElectiveRun.mockImplementation(() => {
      call += 1
      if (call === 2) return Promise.reject(new Error('read failed'))
      return Promise.resolve(STATE)
    })
    render(<AssignmentPanel {...baseProps({ onError })} />)
    fireEvent.click(await screen.findByTestId('run-list-row-pending-run-1'))

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1))
    // ROUND 2 — the sentence is the FAILURE, not the generic one. Round 1 sent
    // the described failure to `onError` and showed the director the same
    // "can't be regenerated right now" they would have seen had nothing gone
    // wrong, so a retry produced the identical sentence with no indication
    // whether it would help. A full-body text search of the rendered page found
    // no trace of the failure anywhere.
    await waitFor(() => {
      const note = screen.getByTestId('run-regenerate-unavailable').textContent
      expect(note).toContain('could not be prepared for regenerating')
      // STILL ACTIONABLE, and it says what to do next rather than only that
      // something is wrong.
      expect(note).toContain('go back to Runs and open it again')
      // The SAME string the error banner gets — one sentence, not two drifting
      // paraphrases of one failure.
      expect(onError).toHaveBeenCalledWith(note)
    })
  })
})

// ---------------------------------------------------------------------------
// DEFECT B — "the commit that never leaves Committing…".
//
// The observed symptom was a renderer stuck on "Committing…" that appeared to
// resolve only after navigating away and back. This pins the renderer's own
// contract: resolution of the awaited IPC ALONE drives the transition, with no
// navigation, no remount, and no second render trigger. If this passes, the
// renderer has no navigation-gated transition and the stall is a consequence of
// how long the awaited call itself took.
// ---------------------------------------------------------------------------
describe('AssignmentPanel — a commit leaves Committing… on its own', () => {
  it('reaches the committed state with no navigation or remount', async () => {
    let resolveCommit
    localClient.commitElectiveRun.mockImplementation(() => new Promise((r) => { resolveCommit = r }))
    localClient.getElectiveRun.mockResolvedValue({
      rows: [], occurrences: [], preferences: [], choices: [], campers: [],
      staleCount: 0, finalizedAgainstStaleGeneration: false, overCapacityOccurrences: [],
    })
    await driveToPreview()
    fireEvent.click(screen.getByText(/Commit Assignments/))
    await waitFor(() => expect(screen.getByText(/Committing…/)).toBeTruthy())

    resolveCommit({ ok: true, runId: 'run-b', counts: { campers: 1, choices: 1, preferences: 1, assignments: 1 }, findings: [] })

    await waitFor(() => expect(screen.queryByText(/Committing…/)).toBeNull())
    await waitFor(() => expect(screen.getByText('Assignments committed')).toBeTruthy())
  })
})
