// @vitest-environment jsdom
//
// T114 follow-up — the ImportScreen GLUE that assembles `divisionSupport` for
// the commit. Both layers under it are tested (divisionSupportByGroup itself,
// and commitIngest's evidence write), but the code that decides WHICH groups
// get provenance sent for them had no coverage — and it carries the one rule
// the feature depends on: a division the FILE STATED is not an inference and
// must not be dressed as one.
//
// Drives the REAL parse -> extractEntities -> buildCommitInputs path (only
// parseTextGrid is mocked, to hand in a grid), modelled on
// ImportScreen.locations.test.jsx.

// Four bunks whose names cluster into two divisions by stem, one page each so
// extractEntities reads groups off the page titles.
const page = (title) => ({
  title,
  timeColumnLabeled: false,
  columns: ['Monday', 'Tuesday'],
  rows: [{ label: '9:00', cells: ['Swim', 'Art'] }],
})
const parsed = { pages: ['Tzofim 1', 'Tzofim 2', 'CIT'].map(page) }
// NOTE: extractEntities reads a stated unit ('C') for the 'CIT' page, so CIT is
// a FILE-STATED division in this fixture — which makes it the right subject for
// the exclusion test below rather than the solo-inference one.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'


vi.mock('../ingest/textGrid', async () => {
  const actual = await vi.importActual('../ingest/textGrid')
  return { ...actual, parseTextGrid: vi.fn(() => parsed) }
})
vi.mock('../ingest/fixedEvents', () => ({ inferFixedEvents: () => ({ fixedEvents: [], dualUseNames: [] }) }))
vi.mock('../hooks/useCohorts', () => ({ useCohorts: () => ({ activeCohort: { id: 'cohort-1' } }) }))
vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn().mockResolvedValue([]),
    write: vi.fn().mockResolvedValue({ status: 'applied' }),
    getCamp: vi.fn().mockResolvedValue({ id: 'camp-1', name: 'Camp' }),
    deleteEntity: vi.fn(),
    ingestCommit: vi.fn().mockResolvedValue({ total: 1, fixedEvents: { created: 0, skipped: [], partial: [] } }),
    ingestReconcile: vi.fn().mockResolvedValue({ planItems: [], fixedEventsReport: {}, legacyPriorityActivities: [], fieldProvenance: {}, evidenceSupport: {} }),
  },
}))

import ImportScreen from './ImportScreen'
import { parseTextGrid } from '../ingest/textGrid'
import { localClient } from '../localClient'

beforeEach(() => {
  vi.clearAllMocks()
  localClient.list.mockResolvedValue([])
  localClient.ingestCommit.mockResolvedValue({ total: 1, fixedEvents: { created: 0, skipped: [], partial: [] } })
})

async function uploadFile() {
  render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
  const input = document.querySelector('input[type="file"]')
  const file = new File(['irrelevant, parseTextGrid is mocked'], 'schedule.txt', { type: 'text/plain' })
  await userEvent.upload(input, file)
  await waitFor(() => expect(screen.queryAllByText(/Tzofim 1/).length).toBeGreaterThan(0))
}

async function commit() {
  await userEvent.click(screen.getByText(/Review \d+ record/))
  // The fixture has no tiers/groups/time_blocks set up yet, so
  // ReconciliationScreen's readiness gate (F3) surfaces required_gap cards
  // that are dismissed (Skip for now) because these tests guard the commit payload.
  // T127 made the exit always reachable and its label state-dependent, so the
  // helper matches any of the three rather than the one the old primary used —
  // unrelated to what this test guards (Q8 case-consistency), so dismiss
  // whatever appears rather than special-casing the fixture.
  await waitFor(() => expect(screen.getByText(/Use this setup|Use what Shoresh understood|Import the rest|Add to camp|Apply \d+ decision/)).toBeTruthy())
  // H1 (docs/work/specs/2026-08-19-roots-reconciliation-audit.md §12 Slice 1)
  // — the default panel view now scopes to unresolved decisions, so
  // dismissing one required_gap removes it from the on-screen list (rather
  // than just marking it dismissed in place, as it did pre-H1). A single
  // upfront `queryAllByText` snapshot goes stale after the first click, so
  // re-query for the next remaining "Skip ... for now" button each pass,
  // the same way a real director would click what's actually still on screen.
  let skipButtons = screen.queryAllByText(/^Skip .* for now/)
  while (skipButtons.length > 0) {
    await userEvent.click(skipButtons[0])
    skipButtons = screen.queryAllByText(/^Skip .* for now/)
  }
  await userEvent.click(await screen.findByText(/Use this setup|Use what Shoresh understood|Import the rest|Add to camp|Apply \d+ decision/))
  await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())
  return localClient.ingestCommit.mock.calls[0][0]
}


describe('ImportScreen — division provenance sent to the commit', () => {
  it('sends support for every group whose division was inferred from its name', async () => {
    await uploadFile()
    const payload = await commit()
    expect(payload.divisionSupport).toBeTruthy()
    const tz = payload.divisionSupport['Tzofim 1']
    expect(tz).toBeTruthy()
    // The reason, not just the answer: which stem clustered it and with whom.
    expect(tz.division).toBe('Tzofim')
    expect(tz.basis).toBe('name_stem')
    expect(tz.members).toContain('Tzofim 2')
  })

  it('sends NO support for a group whose division the file stated outright', async () => {
    // The whole point of the filter: a stated fact is not an inference and must
    // not be dressed as one. This is the assertion that caught the real defect —
    // the filter was reading proposal.groupUnits AFTER it had been overwritten
    // with the inferred divisions merged in, so it matched every group and
    // shipped an empty divisionSupport from every import.
    await uploadFile()
    const payload = await commit()
    expect(payload.links.groups.CIT).toBeTruthy()
    expect(payload.divisionSupport.CIT).toBeUndefined()
  })

  it('never invents a group the proposal does not contain', async () => {
    await uploadFile()
    const payload = await commit()
    // Non-vacuous: an empty divisionSupport would satisfy the loop below while
    // meaning the feature sent nothing at all.
    expect(Object.keys(payload.divisionSupport).length).toBeGreaterThan(0)
    for (const name of Object.keys(payload.divisionSupport)) {
      expect(payload.approved.groups.map((g) => g.name ?? g)).toContain(name)
    }
  })
})

// B4 (docs/adr/2026-08-10-ingestion-evidence-persistence.md): the commit writes an activity's
// inferred-field evidence only when the rule carries the observation it came from (rule.support,
// electron/ops/ingest.js writeActivityEvidence). ImportScreen used to drop it from outgoingRules,
// so no app import ever wrote that evidence.
describe('ImportScreen — activity rule evidence sent to the commit', () => {
  it('sends each inferred rule with the observation it came from', async () => {
    await uploadFile()
    const payload = await commit()
    const swim = payload.activityRules.Swim
    expect(swim.support).toMatchObject({ appearances: 3 })
    expect(swim.support.matched_groups.length).toBeGreaterThan(0)
    expect(typeof swim.eligibility_known).toBe('boolean')
  })
})

// T40 slice 3a — a one-day special schedule must be recognised and stopped,
// not silently folded into the camp's permanent weekly setup.
const FOUR_GROUPS = [
  { id: 'g1', name: 'Lil Chai' }, { id: 'g2', name: 'Chaverim' },
  { id: 'g3', name: 'Shalom' }, { id: 'g4', name: 'Giborim' },
]
const maccabiahFile = () => new File(['x'], 'maccabiah.txt', { type: 'text/plain' })
function mockSpecialDayFile() {
  parseTextGrid.mockReturnValue({
    pages: [{
      title: '"Among Us" Maccabiah Schedule 2022',
      columns: ['Lil Chai', 'Chaverim', 'Shalom', 'Giborim'],
      rows: [
        { label: '9:15', cells: ['Opening', 'Opening', 'Opening', 'Opening'] },
        { label: '10:15', cells: ['Pool - Unit Heads', 'Stem - Sylvia', 'Values - Laura', 'Gym - Tomer'] },
      ],
    }],
  })
}

describe('ImportScreen — declines a one-day special schedule (T40)', () => {
  it('names the day and says what it found, and imports nothing', async () => {
    parseTextGrid.mockReturnValueOnce({
      pages: [{
        title: '"Among Us" Maccabiah Schedule 2022',
        columns: ['Lil Chai', 'Chaverim', 'Shalom', 'Giborim'],
        rows: [
          { label: '9:15', cells: ['Opening', 'Opening', 'Opening', 'Opening'] },
          { label: '10:15', cells: ['Pool - Unit Heads', 'Stem - Sylvia', 'Values - Laura', 'Gym - Tomer'] },
        ],
      }],
    })
    render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
    const input = document.querySelector('input[type="file"]')
    await userEvent.upload(input, new File(['x'], 'maccabiah.txt', { type: 'text/plain' }))

    await waitFor(() => expect(screen.getByText(/single-day schedule/i)).toBeTruthy())
    // The director is told WHICH day, and what it would cost — not just that
    // something was refused.
    expect(screen.getByText(/Among Us/)).toBeTruthy()
    expect(screen.getByText(/2 periods across 4 groups/)).toBeTruthy()
    // It never reaches the WEEKLY commit path.
    expect(localClient.ingestCommit).not.toHaveBeenCalled()
  })

  it('cannot be built while a column matches no group', async () => {
    // Building now would silently leave that share of the day empty.
    mockSpecialDayFile()
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? [{ id: 'g1', name: 'Lil Chai' }] : []))
    render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
    await userEvent.upload(document.querySelector('input[type="file"]'), maccabiahFile())

    const build = await screen.findByRole('button', { name: /Build this special day/i })
    expect(build.disabled).toBe(true)
    expect(screen.getByText(/are not groups/i)).toBeTruthy()
    await userEvent.click(build)
    expect(localClient.write).not.toHaveBeenCalled()
    expect(localClient.ingestCommit).not.toHaveBeenCalled()
  })

  it('says what building it would ADD to the camp before anything is written', async () => {
    mockSpecialDayFile()
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? FOUR_GROUPS : []))
    render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
    await userEvent.upload(document.querySelector('input[type="file"]'), maccabiahFile())

    await screen.findByRole('button', { name: /Build this special day/i })
    // Opening, Pool, Stem, Values, Gym — the five the file uses and the camp
    // does not have. Named individually so the director can see exactly what
    // agreeing to this adds to their permanent catalog.
    expect(screen.getByText((_, el) => /adds 5 new activities/i.test(el?.textContent ?? ''), { selector: 'p' })).toBeTruthy()
    expect(screen.getByText((_, el) => /Opening.*Pool/is.test(el?.textContent ?? ''), { selector: 'p' })).toBeTruthy()
    expect(localClient.write).not.toHaveBeenCalled()
    expect(localClient.ingestCommit).not.toHaveBeenCalled()
  })

  it('shows a meal as an event, not as a new activity', async () => {
    parseTextGrid.mockReturnValue({
      pages: [{
        title: 'Color War Day',
        columns: ['Lil Chai', 'Chaverim', 'Shalom', 'Giborim'],
        rows: [
          { label: '9:15', cells: ['Lunch', 'Lunch', 'Lunch', 'Lunch'] },
          { label: '10:15', cells: ['Pool', 'Pool', 'Pool', 'Pool'] },
        ],
      }],
    })
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? FOUR_GROUPS : []))
    render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
    await userEvent.upload(document.querySelector('input[type="file"]'), maccabiahFile())

    await screen.findByRole('button', { name: /Build this special day/i })
    expect(screen.getByText((_, el) => /adds 1 new activity to your camp: Pool\./i.test(el?.textContent ?? ''), { selector: 'p' })).toBeTruthy()
    expect(screen.getByText((_, el) => /Shows as events, not activities: Lunch/i.test(el?.textContent ?? ''), { selector: 'p' })).toBeTruthy()
  })

  const buildDay = async () => {
    mockSpecialDayFile()
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'groups' ? FOUR_GROUPS : []))
    render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
    await userEvent.upload(document.querySelector('input[type="file"]'), maccabiahFile())
    await userEvent.click(await screen.findByRole('button', { name: /Build this special day/i }))
  }

  it('builds the day, its periods and its cells when the director confirms', async () => {
    localClient.ingestCommit.mockResolvedValue({ specialDay: { created: true, name: '"Among Us" Maccabiah Schedule 2022' } })
    await buildDay()
    await waitFor(() => expect(screen.getByText(/Special day built/i)).toBeTruthy())

    expect(localClient.ingestCommit).toHaveBeenCalledTimes(1)
    const payload = localClient.ingestCommit.mock.calls[0][0]
    expect(payload.approved).toEqual({})
    expect(payload.links).toEqual({})
    expect(payload.specialDay.name).toMatch(/Among Us/)
    expect(payload.specialDay.timeBlocks.length).toBe(2)
    // Two periods x four groups, every cell filled in this fixture.
    expect(payload.specialDay.slots.length).toBe(8)
    expect(localClient.write).not.toHaveBeenCalled()
  })

  it('keeps the staff names, which the grid has nowhere to put', async () => {
    localClient.ingestCommit.mockResolvedValue({ specialDay: { created: true, name: 'x' } })
    await buildDay()
    await waitFor(() => expect(screen.getByText(/Special day built/i)).toBeTruthy())

    expect(String(localClient.ingestCommit.mock.calls[0][0].specialDay.notes)).toContain('Unit Heads')
  })

  it('builds nothing and says so when the atomic commit fails', async () => {
    localClient.ingestCommit.mockRejectedValue(new Error('disk full'))
    await buildDay()

    const msg = await screen.findByText(/Special day not built/i)
    expect(msg).toBeTruthy()
    expect(screen.queryByText(/Special day built/i)).toBeNull()
    expect(localClient.write).not.toHaveBeenCalled()
    // Nothing was written, so retrying is honest and offered.
    expect(screen.getByRole('button', { name: /Build this special day/i })).toBeTruthy()
  })
})

// T147 — places. Drives the real parse -> match -> confirm -> commit path,
// because every defect found in this session's reviews lived in the glue
// between two layers that were each individually green.
describe('ImportScreen — activity-to-place bindings (T147)', () => {
  const withLocations = (locations) => {
    parseTextGrid.mockReturnValue({
      pages: [{
        title: 'Bunk 1',
        columns: ['Monday', 'Tuesday'],
        rows: [
          { label: '9:15', cells: ['Art', 'Slingshots'] },
          { label: '10:00', cells: ['Sports', 'Art'] },
        ],
      }],
    })
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'locations' ? locations : []))
  }
  const upload = async () => {
    render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
    await userEvent.upload(document.querySelector('input[type="file"]'), new File(['x'], 'sched.txt', { type: 'text/plain' }))
  }

  it('offers a binding when the activity and the place share a name', async () => {
    withLocations([{ id: 'l1', camp_id: 'camp-1', name: 'Art' }])
    await upload()
    expect(await screen.findByText('Art → Art')).toBeTruthy()
  })

  it('does NOT offer Slingshots → Slingshot Range', async () => {
    // The decisive case: it is at the archery range. A plausible wrong answer
    // in a review list is worse than no answer.
    withLocations([
      { id: 'l1', camp_id: 'camp-1', name: 'Slingshot Range' },
      { id: 'l2', camp_id: 'camp-1', name: 'Archery Range' },
    ])
    await upload()
    await waitFor(() => expect(screen.queryByText(/^Locations$/)).toBeTruthy())
    expect(screen.queryByText(/Slingshots →/)).toBeNull()
  })

  it('sends a ticked binding to the commit, and only that one', async () => {
    withLocations([
      { id: 'l1', camp_id: 'camp-1', name: 'Art' },
      { id: 'l2', camp_id: 'camp-1', name: 'Sports' },
    ])
    await upload()
    // Bindings are ticked OFF by default — confirmation has to be an act, not
    // an omission, because a wrong binding is invisible. Tick Art; leave Sports
    // alone ("usually outside on the field but could be in the gym").
    await userEvent.click(await screen.findByRole('checkbox', { name: /Art → Art/ }))
    const payload = await commit()
    expect(payload.activityRules.Art.location).toBe('Art')
    expect(payload.activityRules.Sports?.location).toBeUndefined()
  })

  it('sends no binding for an activity the FILE already placed', async () => {
    // A stated fact always beats a proposal.
    parseTextGrid.mockReturnValue({
      pages: [{
        title: 'Bunk 1', columns: ['Monday'],
        rows: [{ label: '9:15', cells: ['Art'], locations: ['Barn'] }],
      }],
    })
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'locations' ? [{ id: 'l1', camp_id: 'camp-1', name: 'Art' }] : []))
    await upload()
    await waitFor(() => expect(screen.queryAllByText(/Art/).length).toBeGreaterThan(0))
    expect(screen.queryByText('Art → Art')).toBeNull()
  })

  it('adds a ticked candidate as a place, and binds nothing to it', async () => {
    withLocations([])
    await upload()
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Slingshots' }))
    const payload = await commit()
    expect(payload.approved.locations).toContain('Slingshots')
    // Offered as a possible PLACE; never asserted as where Slingshots happens.
    expect(payload.activityRules.Slingshots?.location).toBeUndefined()
  })

  it('adds nothing for a candidate left unticked', async () => {
    withLocations([])
    await upload()
    await screen.findByRole('checkbox', { name: 'Slingshots' })
    const payload = await commit()
    expect(payload.approved.locations ?? []).not.toContain('Slingshots')
  })
})

// Red Hat (T147 review) — the THIRD feature this session to need the
// commit-time re-derivation. A binding is keyed on the activity name as spelled
// at PARSE time; a name-variant merge re-keys it, and a stale lookup misses
// silently: the checkbox stays ticked and the write never happens.
describe('ImportScreen — a ticked binding survives a name-variant merge (T147)', () => {
  it('still reaches the commit after the activity is re-keyed', async () => {
    parseTextGrid.mockReturnValue({
      pages: [{
        title: 'Bunk 1', columns: ['Monday', 'Tuesday'],
        rows: [{ label: '9:15', cells: ['Art', 'Art'] }, { label: '10:00', cells: ['Art', 'Art'] }],
      }],
    })
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'locations' ? [{ id: 'l1', camp_id: 'camp-1', name: 'Art' }] : []))
    render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
    await userEvent.upload(document.querySelector('input[type="file"]'), new File(['x'], 'sched.txt', { type: 'text/plain' }))

    await userEvent.click(await screen.findByRole('checkbox', { name: /Art → Art/ }))
    const payload = await commit()
    expect(payload.activityRules.Art.location).toBe('Art')
  })
})
