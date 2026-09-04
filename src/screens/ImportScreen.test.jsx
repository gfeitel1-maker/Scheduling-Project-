// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// T35 — the rule summary this test checks for is inferred from activityPages/
// seenCounts/dayCount, which real parsing would have to build a whole grid to
// exercise. Stubbing extractEntities/parseTextGrid keeps the test about
// "does the inferred rule render and drive the commit payload", not about the
// grid parser (which has its own tests).
vi.mock('../ingest/textGrid', () => ({ parseTextGrid: vi.fn(() => ({ pages: [{ title: 'x', columns: [], rows: [] }] })) }))
// Base proposal fixture, reused as the default mock return and cloned by
// individual tests (via extractEntities.mockReturnValueOnce) that need a
// different activity shape — e.g. one with no per-group signal at all, to
// drive the eligibility-unknown branch (round 2 review).
const baseProposal = {
  orientation: { columns: 'days', pages: 'groups', confident: true },
  entities: {
    groups: ['Yeladim', 'Bogrim'],
    days_of_operation: ['Monday', 'Tuesday'],
    time_blocks: [],
    activities: ['Swim'],
    tiers: [],
    cohorts: [],
  },
  groupUnits: {},
  groupNameByTitle: {},
  activityPages: { swim: ['Yeladim'] },
  seenCounts: { activities: { Swim: 4 }, activityUnitShare: { swim: 0.9 } },
  counts: { groups: 2, days_of_operation: 2, activities: 1 },
}
vi.mock('../ingest/extractEntities', async () => {
  const actual = await vi.importActual('../ingest/extractEntities')
  return {
    ...actual,
    extractEntities: vi.fn(),
  }
})
vi.mock('../ingest/fixedEvents', () => ({ inferFixedEvents: vi.fn(() => ({ fixedEvents: [] })) }))
// HIGH regression test (split-failure surfacing) — mocked so a staged
// two-row split can be forced to fail at commit time without exercising
// twoRowSplit.js's own real write logic (that module has its own tests).
vi.mock('../ingest/twoRowSplit', async () => {
  const actual = await vi.importActual('../ingest/twoRowSplit')
  return {
    ...actual,
    emitTwoRowSplit: vi.fn(),
    pinActivityAsserted: vi.fn(),
  }
})
vi.mock('../hooks/useCohorts', () => ({ useCohorts: () => ({ activeCohort: { id: 'cohort-1' } }) }))
vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn().mockResolvedValue([]),
    // useSetupCounts calls getCamp() in a mount effect on every ImportScreen
    // render, so the mock must implement it or every test throws in that effect.
    getCamp: vi.fn().mockResolvedValue({ id: 'camp-1', name: 'Camp' }),
    // T61 — present so the "the renderer deletes nothing" test can assert it
    // was never reached, not because this screen may call it.
    deleteEntity: vi.fn(),
    ingestCommit: vi.fn().mockResolvedValue({ total: 3, fixedEvents: { created: 0, skipped: [], partial: [] } }),
    ingestReconcile: vi.fn().mockResolvedValue({ planItems: [], fixedEventsReport: {}, legacyPriorityActivities: [], fieldProvenance: {}, evidenceSupport: {} }),
    // T118 slice 4 — the camp's already-confirmed compound-cell-pattern
    // decisions, fetched at parse time. Defaults to none; individual tests
    // override with mockResolvedValueOnce to prove the re-import regression
    // (a confirmed pattern never shows a card again).
    listCompoundCellDecisions: vi.fn().mockResolvedValue(new Map()),
  },
}))

import ImportScreen from './ImportScreen'
import { localClient } from '../localClient'
import { extractEntities } from '../ingest/extractEntities'
import { parseTextGrid } from '../ingest/textGrid'
import { inferFixedEvents } from '../ingest/fixedEvents'
import { emitTwoRowSplit } from '../ingest/twoRowSplit'
import { IMPORT_LIMITS } from '../utils/exportSanitize'

beforeEach(() => {
  vi.clearAllMocks()
  extractEntities.mockReturnValue(baseProposal)
  localClient.list.mockResolvedValue([])
  localClient.ingestCommit.mockResolvedValue({ total: 3, fixedEvents: { created: 0, skipped: [], partial: [] } })
  localClient.listCompoundCellDecisions.mockResolvedValue(new Map())
  inferFixedEvents.mockReturnValue({ fixedEvents: [] })
})

// The Replace warning sentences use JSX fragments with a <strong> in the
// middle, so their text is split across sibling text nodes — screen.getByText
// with a plain regex can't span that. This matches the deepest element whose
// full text satisfies the regex, the pattern RTL's own docs recommend for
// text broken up by markup.
function textNode(regex) {
  return (_, element) => {
    const hasText = (node) => regex.test(node.textContent ?? '')
    return hasText(element) && Array.from(element.children).every((child) => !hasText(child))
  }
}

async function uploadFile() {
  render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
  const input = document.querySelector('input[type="file"]')
  const file = new File(['irrelevant, parseTextGrid is mocked'], 'schedule.txt', { type: 'text/plain' })
  await userEvent.upload(input, file)
  await waitFor(() => expect(screen.getAllByText(/Swim/).length).toBeGreaterThan(0))
}

// baseProposal has no tiers/groups/time_blocks set up yet, so
// ReconciliationScreen's readiness gate (F3, docs/adr/2026-08-17-onescreen-
// reconciliation-merge.md §5) surfaces required_gap cards that must be
// dismissed (Skip for now) before "Use this setup" enables. Unrelated to what
// these tests guard (T35 rule inference / commit payload shape), so dismiss
// whatever appears rather than special-casing every fixture.
async function goToCommit() {
  await userEvent.click(screen.getByText(/Add \d+ record/))
  await waitFor(() => expect(screen.getByText(/Use this setup/)).toBeTruthy())
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
  await userEvent.click(await screen.findByText('Use this setup'))
}

describe('ImportScreen — residual report (T36)', () => {
  it('renders a non-blocking "not recognised" section for unmatched cell content, before commit', async () => {
    extractEntities.mockReturnValueOnce({
      ...baseProposal,
      residual: { cells: [{ value: 'Block 2', count: 3 }] },
    })
    await uploadFile()
    expect(screen.getByText(/not recognised/i)).toBeTruthy()
    expect(screen.getByText(textNode(/Block 2.*3.*cells/))).toBeTruthy()
    // Non-blocking: the commit action is still present and enabled.
    expect(screen.getByText(/Add \d+ record/)).toBeTruthy()
  })

  it('renders no residual section when nothing was left unmatched', async () => {
    extractEntities.mockReturnValueOnce({ ...baseProposal, residual: { cells: [] } })
    await uploadFile()
    expect(screen.queryByText(/not recognised/i)).toBeNull()
  })
})

describe('ImportScreen — oversized text-file guard (F4)', () => {
  it('rejects an oversized .txt file before it reaches the parser', async () => {
    render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
    const input = document.querySelector('input[type="file"]')
    const file = new File(['x'], 'schedule.txt', { type: 'text/plain' })
    // A real 11MB string would blow the test's memory — the guard reads
    // file.size, so overriding it exercises the same code path a huge file hits.
    Object.defineProperty(file, 'size', { value: IMPORT_LIMITS.maxBytes + 1 })
    await userEvent.upload(input, file)
    await waitFor(() => expect(screen.getByText(/could not be read/i)).toBeTruthy())
    // Fails closed: the bytes never reach parseTextGrid.
    expect(parseTextGrid).not.toHaveBeenCalled()
  })
})

describe('ImportScreen — inferred activity rules (T35)', () => {
  it('renders a rule summary for a proposed activity, collapsed by default with the full editor behind Adjust', async () => {
    await uploadFile()
    // Swim: 4 appearances / 1 matched group = 4/wk (bd40e7c, no day division).
    expect(screen.getByText(/Groups: Yeladim/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Adjust/ }))
    // B2 (commit 57f75ed): prevalence alone never manufactures a priority, so an
    // inferred rule carries no priority and the editor's select shows its
    // UNKNOWN→low default rather than a fabricated "High".
    expect(screen.getByRole('option', { name: 'Low', selected: true })).toBeTruthy()
  })

  // Round 2 — the eligibility-unknown signal (T35 Fix 2b) must stay
  // full-contrast and visible in the COLLAPSED row without clicking Adjust,
  // or a director could tick-and-commit an activity worth checking without
  // ever seeing the warning.
  it('shows the full-contrast "worth checking" signal on the collapsed row when eligibility is unknown', async () => {
    extractEntities.mockReturnValueOnce({
      ...baseProposal,
      // No entry for "swim" in activityPages — no per-group signal at all.
      activityPages: {},
    })
    await uploadFile()
    const worthChecking = screen.getByText(/Worth checking — groups unclear/)
    expect(worthChecking).toBeTruthy()
    expect(worthChecking.style.color).toBe('var(--text)')
    // Not clicked Adjust — the full editor's own sentence must not be present yet.
    expect(screen.queryByText(/Shoresh couldn.t tell from this file.s layout/)).toBeNull()
  })

  // Round 2 — a rule-less activity (never inferred, e.g. it never appeared
  // in a days-oriented grid, T35 gotcha) must read as "Not set", not
  // fabricate a range from undefined min/max.
  it('shows "Not set" for frequency in the collapsed row when no rule was inferred', async () => {
    await uploadFile()
    await userEvent.click(screen.getByText('Clear inferred rules'))
    expect(screen.getByText(/Not set/)).toBeTruthy()
  })

  it('sends resolved rules only for approved activities on commit', async () => {
    await uploadFile()
    await goToCommit()
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())
    const [{ activityRules }] = localClient.ingestCommit.mock.calls[0]
    // bd40e7c — weekly frequency is appearances ÷ matched groups (no day
    // division): 4 appearances / 1 matched group = 4/wk, +2 headroom.
    expect(activityRules.Swim).toMatchObject({ min_per_week: 4, max_per_week: 6 })
    // B2 (commit 57f75ed): an inferred rule carries no priority VALUE — it stays
    // UNKNOWN (undefined) and is resolved to the engine's two-valued contract at
    // generation time, not manufactured from prevalence here.
    expect(activityRules.Swim.priority).toBeUndefined()
  })

  // Provenance follow-up (docs/adr/2026-08-09-activity-rule-hand-edit-provenance.md):
  // a rule field the director hand-edits during review is flagged in
  // `humanEditedFields.activities` so the commit stamps only that field
  // source:'human' (Policy A protection against a silent re-import overwrite) —
  // the activity-rule half of the same mechanism the unit column uses for groups.
  it('flags a hand-edited rule field in humanEditedFields.activities, field-level', async () => {
    await uploadFile()
    // The number inputs live in the editor behind Adjust (collapsed by default).
    await userEvent.click(screen.getByRole('button', { name: /Adjust/ }))
    // The Swim row's first number input is min_per_week; edit it.
    const minInput = screen.getAllByRole('spinbutton')[0]
    fireEvent.change(minInput, { target: { value: '5' } })

    await goToCommit()
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())

    const [{ humanEditedFields, activityRules }] = localClient.ingestCommit.mock.calls[0]
    expect(activityRules.Swim.min_per_week).toBe(5)
    // Only the touched field is marked human — max_per_week stays re-importable.
    expect(humanEditedFields.activities.Swim).toContain('min_per_week')
    expect(humanEditedFields.activities.Swim).not.toContain('max_per_week')
  })

  // Control: a purely file-inferred rule (nothing touched) sends NO
  // humanEditedFields.activities entry, so its ops stay source:'import' and a
  // later re-import can still update them — the fix adds no friction.
  it('sends no humanEditedFields.activities entry for an untouched, inferred rule', async () => {
    await uploadFile()
    await goToCommit()
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())

    const [{ humanEditedFields }] = localClient.ingestCommit.mock.calls[0]
    expect(humanEditedFields.activities.Swim).toBeUndefined()
  })

  // T61 — the Replace teardown moved into the main process. The renderer must
  // no longer delete anything itself; it says which mode and awaits once.
  it('commits in add mode without deleting a single row itself', async () => {
    await uploadFile()
    await goToCommit()
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())
    expect(localClient.ingestCommit.mock.calls[0][0].mode).toBe('add')
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
  })

  it('tells the director to use the main computer when the handler refuses on a Client', async () => {
    // The refusal names the one thing they can do about it; the generic
    // "not something the app recognised" fallback would bury that.
    localClient.ingestCommit.mockRejectedValue(new Error('Import can only be run on the main computer.'))
    await uploadFile()
    await goToCommit()
    await waitFor(() => expect(screen.getByText(/main computer/)).toBeTruthy())
    expect(screen.getByText(/Nothing was imported/)).toBeTruthy()
  })

  // Round 2 (Red Hat HIGH) — replaceScope (electron/ops/ingest.js) tears down
  // WHERE camp_id = ? with no cohort filter, but the confirmation used to be
  // computed from a Program-filtered set (T33 duplicate detection). On a
  // multi-Program camp the director confirmed a small Program-scoped number
  // while every Program's setup was destroyed underneath it. The confirmation
  // must show the camp-wide count that Replace actually deletes.
  it('shows the camp-wide existing count, not the active-Program count, in the Replace confirmation', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'tiers') {
        // 1 in the active Program (cohort-1), 2 total across the camp.
        return Promise.resolve([
          { id: 't1', cohort_id: 'cohort-1' },
          { id: 't2', cohort_id: 'cohort-2' },
          { id: 't3', cohort_id: 'cohort-2' },
        ])
      }
      if (entity === 'time_blocks') {
        // 0 in the active Program, 2 total across the camp.
        return Promise.resolve([
          { id: 'b1', cohort_id: 'cohort-2' },
          { id: 'b2', cohort_id: 'cohort-2' },
        ])
      }
      return Promise.resolve([])
    })
    await uploadFile()
    // Program-scoped total would be 1 (one tier, no time blocks); camp-wide
    // total is 5. The confirmation must say 5, never 1.
    expect(screen.getByText(/Your camp already has/).textContent).toContain('5')
    expect(screen.queryByText(/Your camp already has\s*1\s/)).toBeNull()
    await userEvent.click(screen.getByText(/Replace them/))
    expect(screen.getByText(/across the entire camp — every Program/).textContent).toContain('5')
  })

  // Round 2 (second reviewer) — the commit button label was still gated on
  // the Program-scoped count, so a multi-Program camp whose active Program
  // holds zero REPLACEABLE rows saw the Replace confirmation panel (driven by
  // the camp-wide count) but a button that still read "Add N records", even
  // though clicking it sends mode: 'replace' and tears down every Program.
  it('reads Replace, not Add, when the active Program has no rows but the camp does', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'tiers') {
        // 0 in the active Program (cohort-1), 2 total across the camp.
        return Promise.resolve([
          { id: 't1', cohort_id: 'cohort-2' },
          { id: 't2', cohort_id: 'cohort-2' },
        ])
      }
      return Promise.resolve([])
    })
    await uploadFile()
    await userEvent.click(screen.getByText(/Replace them/))
    expect(screen.getByText(/Replace with/)).toBeTruthy()
    expect(screen.queryByText(/Add \d+ record/)).toBeNull()
  })

  // T61 round 3 (Red Hat) — replaceScope wipes template_slots/overlays for
  // BOTH schedule routes, camp-wide, but the director previously learned the
  // count only from the after-the-fact success banner. It must appear in the
  // pre-confirm warning, naming both routes by their real nav labels.
  it('warns about cleared slots on both routes when the camp has placed slots', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'tiers') return Promise.resolve([{ id: 't1', cohort_id: 'cohort-1' }])
      if (entity === 'template_slots') return Promise.resolve([{ id: 's1' }, { id: 's2' }, { id: 's3' }])
      return Promise.resolve([])
    })
    await uploadFile()
    await userEvent.click(screen.getByText(/Replace them/))
    expect(screen.getByText(/Manual Build/)).toBeTruthy()
    expect(screen.getByText(/Generated Schedule/)).toBeTruthy()
    expect(screen.getByText(/3 slots/)).toBeTruthy()
  })

  it('does not warn about slots when the camp has none placed', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'tiers') return Promise.resolve([{ id: 't1', cohort_id: 'cohort-1' }])
      return Promise.resolve([])
    })
    await uploadFile()
    await userEvent.click(screen.getByText(/Replace them/))
    expect(screen.queryByText(/Manual Build/)).toBeNull()
    expect(screen.queryByText(/Generated Schedule/)).toBeNull()
  })

  it('names all five entities Replace destroys', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'tiers') return Promise.resolve([{ id: 't1', cohort_id: 'cohort-1' }])
      return Promise.resolve([])
    })
    await uploadFile()
    await userEvent.click(screen.getByText(/Replace them/))
    const replaceSentence = screen.getByText(/This will replace all/)
    for (const name of ['Age Divisions', 'Groups', 'Days', 'Time Blocks', 'Activities']) {
      expect(replaceSentence.textContent).toContain(name)
    }
  })

  // Round 2 — consolidated destructive copy (design spec): the Replace
  // option's own sub-copy no longer restates "recoverable from Trash" (the
  // accent recoverable box below is now the sole place that says it), but
  // still names the camp-wide scope and the real count.
  it('drops the Trash sentence from the Replace option copy while keeping the count and camp-wide scope', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'tiers') return Promise.resolve([{ id: 't1', cohort_id: 'cohort-1' }])
      return Promise.resolve([])
    })
    await uploadFile()
    await userEvent.click(screen.getByText(/Replace them/))
    const replaceSentence = screen.getByText(/This will replace all/)
    expect(replaceSentence.textContent).not.toContain('Trash')
    expect(replaceSentence.textContent).toContain('every Program')
    expect(replaceSentence.textContent).toContain(String(1))
  })
})

// T68 — Fixed Events (anchor_activities) were destroyed by Replace but never
// named pre-confirm; the director found out only after committing, buried in
// the aggregate success total. This also covers the split into a recoverable
// (--accent) sub-block and an irreversible (--danger) sub-block, since both
// regressed together would look identical to the old single-box warning.
describe('ImportScreen — Replace warning names Recurring Events and separates the irreversible item (T68)', () => {
  it('warns about cleared Recurring Events with a live count when the camp has anchors, and never says "anchor"', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'tiers') return Promise.resolve([{ id: 't1', cohort_id: 'cohort-1' }])
      if (entity === 'anchor_activities') return Promise.resolve([{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }])
      return Promise.resolve([])
    })
    const { container } = render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
    const input = document.querySelector('input[type="file"]')
    const file = new File(['irrelevant, parseTextGrid is mocked'], 'schedule.txt', { type: 'text/plain' })
    await userEvent.upload(input, file)
    await waitFor(() => expect(screen.getAllByText(/Swim/).length).toBeGreaterThan(0))
    await userEvent.click(screen.getByText(/Replace them/))
    expect(screen.getByText(textNode(/Your\s*3\s*Recurring Events will/))).toBeTruthy()
    expect(screen.getByText(/They are recoverable from Trash/)).toBeTruthy()
    expect(container.textContent).not.toMatch(/anchor/i)
  })

  it('does not warn about Recurring Events when the camp has none', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'tiers') return Promise.resolve([{ id: 't1', cohort_id: 'cohort-1' }])
      return Promise.resolve([])
    })
    await uploadFile()
    await userEvent.click(screen.getByText(/Replace them/))
    expect(screen.queryByText(/Recurring Event/)).toBeNull()
  })

  it('uses singular phrasing for exactly one Recurring Event', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'tiers') return Promise.resolve([{ id: 't1', cohort_id: 'cohort-1' }])
      if (entity === 'anchor_activities') return Promise.resolve([{ id: 'a1' }])
      return Promise.resolve([])
    })
    await uploadFile()
    await userEvent.click(screen.getByText(/Replace them/))
    expect(screen.getByText(textNode(/Your\s*1\s*Recurring Event will/))).toBeTruthy()
    expect(screen.getByText(/It is recoverable from Trash/)).toBeTruthy()
    expect(screen.queryByText(/Recurring Events will/)).toBeNull()
  })

  it('renders the recoverable and irreversible warnings in two separate bordered containers', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'tiers') return Promise.resolve([{ id: 't1', cohort_id: 'cohort-1' }])
      if (entity === 'anchor_activities') return Promise.resolve([{ id: 'a1' }])
      if (entity === 'schedule_snapshots') return Promise.resolve([{ id: 'v1' }])
      return Promise.resolve([])
    })
    await uploadFile()
    await userEvent.click(screen.getByText(/Replace them/))

    const irreversibleLabel = screen.getByText('Cannot be undone')
    // Walk up to the bordered container the spec requires — the one painted
    // with --danger — and confirm it holds the snapshot sentence but not the
    // Recurring Events sentence, i.e. the two are not sharing one box.
    let dangerContainer = irreversibleLabel.parentElement
    while (dangerContainer && !/color-mix\(in srgb, var\(--danger\)/.test(dangerContainer.getAttribute('style') || '')) {
      dangerContainer = dangerContainer.parentElement
    }
    expect(dangerContainer).toBeTruthy()
    expect(dangerContainer.textContent).toMatch(/saved schedule version/)
    expect(dangerContainer.textContent).not.toMatch(/Recurring Event/)

    const fixedEventsLine = screen.getByText(/Recurring Event will/)
    let accentContainer = fixedEventsLine.parentElement
    while (accentContainer && !/color-mix\(in srgb, var\(--accent\)/.test(accentContainer.getAttribute('style') || '')) {
      accentContainer = accentContainer.parentElement
    }
    expect(accentContainer).toBeTruthy()
    expect(accentContainer.textContent).not.toMatch(/saved schedule version/)
    expect(accentContainer).not.toBe(dangerContainer)
  })

  it('still shows the irreversible block with its "Cannot be undone" label when it is the only sub-block present', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'tiers') return Promise.resolve([{ id: 't1', cohort_id: 'cohort-1' }])
      if (entity === 'schedule_snapshots') return Promise.resolve([{ id: 'v1' }])
      // slots, anchors, day overrides all empty — the recoverable sub-block
      // must not render, but the irreversible one must still stand alone
      // rather than degrading to plain unlabeled text.
      return Promise.resolve([])
    })
    await uploadFile()
    await userEvent.click(screen.getByText(/Replace them/))
    expect(screen.getByText('Cannot be undone')).toBeTruthy()
    expect(screen.getByText(/saved schedule version/)).toBeTruthy()
    expect(screen.queryByText(/Manual Build/)).toBeNull()
    expect(screen.queryByText(/Recurring Event/)).toBeNull()
    expect(screen.queryByText(/Day Override/)).toBeNull()
  })

  it('renders no warning block at all when slots, anchors, snapshots, and day overrides are all zero', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'tiers') return Promise.resolve([{ id: 't1', cohort_id: 'cohort-1' }])
      return Promise.resolve([])
    })
    await uploadFile()
    await userEvent.click(screen.getByText(/Replace them/))
    expect(screen.queryByText('Cannot be undone')).toBeNull()
    expect(screen.queryByText(/Manual Build/)).toBeNull()
    expect(screen.queryByText(/Recurring Event/)).toBeNull()
    expect(screen.queryByText(/saved schedule version/)).toBeNull()
    expect(screen.queryByText(/Day Override/)).toBeNull()
  })
})

// ADR docs/adr/2026-08-28-roots-home-is-a-distinct-screen.md — a finished
// import no longer rests on a local ImportScreen receipt, and Roots itself
// has no post-import banner of its own (that mechanism was retired along
// with the `onImported` carrier). A finished import just navigates to Roots.
describe('ImportScreen — routes a finished import to Roots', () => {
  it('navigates to roots, with no local receipt as the resting surface', async () => {
    const onNavigate = vi.fn()
    localClient.ingestCommit.mockResolvedValue({
      total: 3,
      fixedEvents: { created: 0, skipped: [], partial: [] },
      invertibleOps: [],
    })
    render(<ImportScreen campId="camp-1" onNavigate={onNavigate} />)
    const input = document.querySelector('input[type="file"]')
    const file = new File(['irrelevant'], 'schedule.txt', { type: 'text/plain' })
    await userEvent.upload(input, file)
    await waitFor(() => expect(screen.getAllByText(/Swim/).length).toBeGreaterThan(0))
    await goToCommit()

    await waitFor(() => expect(onNavigate).toHaveBeenCalledWith('roots'))
    // The old local receipt must NOT be the resting surface anymore.
    expect(screen.queryByText(/Imported 3 record/)).toBeNull()
  })
})

// Code review HIGH fix — removing the `justImported` carrier (correct per
// the ADR, since Roots no longer has a post-import banner) had silently
// orphaned split-failure reporting: applyStagedSplits' failures used to ride
// on the outcome handed to onImported, a prop App.jsx never passes anymore.
// A partial split failure must still be visible to the director — surfaced
// locally in ImportScreen, at the moment it happens, not carried anywhere.
describe('ImportScreen — a partial split failure is surfaced (not silently dropped)', () => {
  function stageADualUseSplit() {
    inferFixedEvents.mockReturnValue({
      fixedEvents: [{
        name: 'Swim', time_block: 'Period 1', days: ['Monday'],
        scope: { is_all_groups: true, groups: [] }, confidence: 'high',
      }],
      dualUseNames: ['Swim'],
    })
    localClient.list.mockImplementation((entity) =>
      Promise.resolve(entity === 'activities' ? [{ id: 'act-swim', name: 'Swim' }] : [])
    )
  }

  it('holds the director on ImportScreen and names the failed split, instead of navigating to Roots as if nothing went wrong', async () => {
    stageADualUseSplit()
    emitTwoRowSplit.mockRejectedValue(new Error('disk full'))
    const onNavigate = vi.fn()
    render(<ImportScreen campId="camp-1" onNavigate={onNavigate} />)

    const input = document.querySelector('input[type="file"]')
    const file = new File(['irrelevant'], 'schedule.txt', { type: 'text/plain' })
    await userEvent.upload(input, file)
    await waitFor(() => expect(screen.getAllByText(/Swim/).length).toBeGreaterThan(0))

    await userEvent.click(screen.getByText(/split into two\?/))
    await userEvent.click(await screen.findByText('Split'))
    await goToCommit()

    await waitFor(() => expect(screen.getByText(/couldn.t be saved/)).toBeTruthy())
    expect(onNavigate).not.toHaveBeenCalledWith('roots')
  })
})

// T93 — Import is host-only, enforced today only at the IPC layer
// (electron/main.js throws "Import can only be run on the main computer."
// when mode === 'client'). Without an early UI gate, a Client-mode director
// can upload/parse/edit/reconcile a whole import and only discover the
// constraint at the final commit. deviceMode is the same signal T86 already
// threads into every screen via App.jsx's screenProps (deviceMode: mode).
describe('ImportScreen — host-only gate on Client-mode devices (T93)', () => {
  it('shows host-only guidance and no live upload control when deviceMode is client', () => {
    render(<ImportScreen campId="camp-1" onNavigate={() => {}} deviceMode="client" />)
    expect(screen.getByText(/main computer/i)).toBeTruthy()
    expect(document.querySelector('input[type="file"]')).toBeNull()
  })

  it('still presents the live upload control when deviceMode is host', () => {
    render(<ImportScreen campId="camp-1" onNavigate={() => {}} deviceMode="host" />)
    expect(document.querySelector('input[type="file"]')).toBeTruthy()
  })

  it('still presents the live upload control when deviceMode is not passed (default/undefined behaves as host)', () => {
    render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
    expect(document.querySelector('input[type="file"]')).toBeTruthy()
  })
})

// Whole-app coherence Wave 2 — every screen should mount with the same enter
// transition (useEnterTransition in src/styles/shared.js) so navigating
// between screens feels consistent. ImportScreen previously rendered its
// root with no transition at all.
describe('ImportScreen — mount transition (coherence Wave 2)', () => {
  it('renders its root container with the enter-transition style', () => {
    const { container } = render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
    const root = container.firstChild
    expect(root.style.transition).toMatch(/opacity/)
  })
})

// T118 slice 4 — "Cells We Weren't Sure About"
// (docs/adr/2026-09-03-compound-cell-interpretation.md). detectCompoundCellPatterns
// itself is real (unmocked, its own unit tests cover the classifier); these
// tests are about the SCREEN's wiring — the card renders, a "wrapper" verdict
// rewrites what commits (structurally different from Longer Blocks, which
// only appends), and the compound_cell_decisions row travels to ingestCommit.
describe('ImportScreen — compound-cell interpretation (T118 slice 4)', () => {
  // "Leave" pairing with two different real activities (Lunch, Swim) is what
  // makes it a wrapper CANDIDATE at all (compoundCellPatterns.js's partner-
  // diversity rule) — a single "Lunch + Leave" pattern alone would look like
  // a fixed name (same shape as "Arts & Crafts") and never surface a card.
  const compoundPages = [{
    title: 'Bunk 1',
    columns: ['Monday'],
    rows: [
      { cells: ['Lunch + Leave'] },
      { cells: ['Lunch + Leave'] },
      { cells: ['Lunch'] },
      { cells: ['Swim + Leave'] },
      { cells: ['Swim'] },
    ],
  }]

  const proposalWithCompoundCells = {
    ...baseProposal,
    entities: { ...baseProposal.entities, activities: ['Lunch + Leave', 'Swim + Leave', 'Lunch', 'Swim'] },
    seenCounts: { activities: { 'Lunch + Leave': 2, 'Swim + Leave': 1, Lunch: 1, Swim: 1 }, activityUnitShare: {} },
  }
  // What extractEntities returns once re-parsed at commit time with the
  // director's "wrapper" verdict folded in (buildCommitInputs) — "Lunch +
  // Leave" is gone; "Swim + Leave" is untouched because that card was never
  // resolved (same "unticked = not written" contract as Longer Blocks).
  const proposalAfterWrapperFold = {
    ...baseProposal,
    entities: { ...baseProposal.entities, activities: ['Swim + Leave', 'Lunch', 'Swim'] },
    seenCounts: { activities: { 'Swim + Leave': 1, Lunch: 3, Swim: 1 }, activityUnitShare: {} },
  }

  it('renders no section at all when the file has zero compound-cell patterns', async () => {
    await uploadFile()
    expect(screen.queryByText("Cells We Weren't Sure About")).toBeNull()
  })

  it('shows a card for a detected pattern; picking "wrapper" then committing folds it upstream and writes the decision', async () => {
    parseTextGrid.mockReturnValueOnce({ pages: compoundPages })
    extractEntities.mockReturnValueOnce(proposalWithCompoundCells) // parse-time call

    render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
    const input = document.querySelector('input[type="file"]')
    const file = new File(['irrelevant, parseTextGrid is mocked'], 'schedule.txt', { type: 'text/plain' })
    await userEvent.upload(input, file)
    await waitFor(() => expect(screen.getByText(/"Lunch \+ Leave"/)).toBeTruthy())

    // A card left untouched (Swim + Leave) must ship nothing extra — verified
    // implicitly below via the compoundCellDecisions array length.
    await userEvent.click(screen.getByRole('button', { name: '"Leave" is a wrapper around "Lunch"' }))
    await waitFor(() => expect(screen.getByText(/won.t become its own activity/)).toBeTruthy())

    extractEntities.mockReturnValueOnce(proposalAfterWrapperFold) // buildCommitInputs' re-parse at commit
    await goToCommit()

    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())
    const call = localClient.ingestCommit.mock.calls[0][0]
    expect(call.approved.activities).not.toContain('Lunch + Leave')
    expect(call.compoundCellDecisions).toEqual([
      { pattern: 'Lunch + Leave', interpretation: 'wrapper', anchor_name: 'Lunch', wrapper_name: 'Leave' },
    ])
  })

  it('a pattern already confirmed at this camp never shows a card again on re-import', async () => {
    localClient.listCompoundCellDecisions.mockResolvedValueOnce(
      new Map([['Lunch + Leave', { interpretation: 'wrapper', anchor_name: 'Lunch', wrapper_name: 'Leave' }]])
    )
    parseTextGrid.mockReturnValueOnce({ pages: compoundPages })
    extractEntities.mockReturnValueOnce(proposalWithCompoundCells)

    render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
    const input = document.querySelector('input[type="file"]')
    const file = new File(['irrelevant, parseTextGrid is mocked'], 'schedule.txt', { type: 'text/plain' })
    await userEvent.upload(input, file)
    await waitFor(() => expect(screen.getAllByText(/Swim/).length).toBeGreaterThan(0))

    expect(screen.queryByText(/"Lunch \+ Leave"/)).toBeNull()
  })

  // 2026-09-03 pressure-testing finding, against a real Camp Mindy file:
  // "Change/Snack" is a genuine wrapper pattern (Change is a transition
  // word), but neither "Change" nor "Snack" ever appears as its own
  // standalone cell in that file, so anchorGuess/wrapperGuess come back
  // null. The v1 UI used to fall back to raw split order ("Change" first in
  // the text) as the guessed anchor — which was BACKWARDS on the real file
  // and would have fabricated a weekly-frequency rule for "Change" itself,
  // with no way for the director to flip a wrong guess. Fix: withhold the
  // specific-direction "wrapper" pill entirely when the classifier itself
  // doesn't know which side is real — as_written/alternatives/not-sure stay.
  it('withholds the specific-direction "wrapper" pill when the classifier cannot tell which side is the real activity', async () => {
    const ambiguousPages = [{
      title: 'Bunk 1',
      columns: ['Monday'],
      rows: [
        { cells: ['Change/Snack'] },
        { cells: ['Change/Snack'] },
        { cells: ['Change/Ga Ga'] },
      ],
    }]
    const proposalWithAmbiguousCompound = {
      ...baseProposal,
      entities: { ...baseProposal.entities, activities: ['Change/Snack', 'Change/Ga Ga'] },
      seenCounts: { activities: { 'Change/Snack': 2, 'Change/Ga Ga': 1 }, activityUnitShare: {} },
    }
    parseTextGrid.mockReturnValueOnce({ pages: ambiguousPages })
    extractEntities.mockReturnValueOnce(proposalWithAmbiguousCompound)

    render(<ImportScreen campId="camp-1" onNavigate={() => {}} />)
    const input = document.querySelector('input[type="file"]')
    const file = new File(['irrelevant, parseTextGrid is mocked'], 'schedule.txt', { type: 'text/plain' })
    await userEvent.upload(input, file)
    await waitFor(() => expect(screen.getByText(/"Change\/Snack"/)).toBeTruthy())

    // No pill can claim a specific direction ("X is a wrapper around Y") —
    // neither ordering of the two real words should appear as a button. Both
    // "Change/Snack" and "Change/Ga Ga" render as separate cards, so the
    // shared pills legitimately appear twice — assert presence, not count.
    expect(screen.queryByRole('button', { name: /is a wrapper around/ })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'One thing, as written' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'These are alternatives — either one' }).length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'Not sure — ask me later' }).length).toBeGreaterThan(0)
  })
})
