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
