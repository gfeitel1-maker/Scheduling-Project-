// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

// T35 — the rule summary this test checks for is inferred from activityPages/
// seenCounts/dayCount, which real parsing would have to build a whole grid to
// exercise. Stubbing extractEntities/parseTextGrid keeps the test about
// "does the inferred rule render and drive the commit payload", not about the
// grid parser (which has its own tests).
vi.mock('../ingest/textGrid', () => ({ parseTextGrid: () => ({ pages: [{ title: 'x', columns: [], rows: [] }] }) }))
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
vi.mock('../ingest/fixedEvents', () => ({ inferFixedEvents: () => ({ fixedEvents: [] }) }))
vi.mock('../hooks/useCohorts', () => ({ useCohorts: () => ({ activeCohort: { id: 'cohort-1' } }) }))
vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn().mockResolvedValue([]),
    // T61 — present so the "the renderer deletes nothing" test can assert it
    // was never reached, not because this screen may call it.
    deleteEntity: vi.fn(),
    ingestCommit: vi.fn().mockResolvedValue({ total: 3, fixedEvents: { created: 0, skipped: [], partial: [] } }),
  },
}))

import ImportScreen from './ImportScreen'
import { localClient } from '../localClient'
import { extractEntities } from '../ingest/extractEntities'

beforeEach(() => {
  vi.clearAllMocks()
  extractEntities.mockReturnValue(baseProposal)
  localClient.list.mockResolvedValue([])
  localClient.ingestCommit.mockResolvedValue({ total: 3, fixedEvents: { created: 0, skipped: [], partial: [] } })
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

describe('ImportScreen — inferred activity rules (T35)', () => {
  it('renders a rule summary for a proposed activity, collapsed by default with the full editor behind Adjust', async () => {
    await uploadFile()
    // Swim: 4 appearances / 1 matched group / 2 days = 2/wk; unitShare 0.9 -> High.
    expect(screen.getByText(/Groups: Yeladim/)).toBeTruthy()
    await userEvent.click(screen.getByRole('button', { name: /Adjust/ }))
    expect(screen.getByRole('option', { name: 'High', selected: true })).toBeTruthy()
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
    await userEvent.click(screen.getByText(/Add \d+ record/))
    await userEvent.click(await screen.findByText(/Commit \d+ record/))
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())
    const [{ activityRules }] = localClient.ingestCommit.mock.calls[0]
    expect(activityRules.Swim).toMatchObject({ min_per_week: 2, max_per_week: 3, priority: 'high' })
  })

  // T61 — the Replace teardown moved into the main process. The renderer must
  // no longer delete anything itself; it says which mode and awaits once.
  it('commits in add mode without deleting a single row itself', async () => {
    await uploadFile()
    await userEvent.click(screen.getByText(/Add \d+ record/))
    await userEvent.click(await screen.findByText(/Commit \d+ record/))
    await waitFor(() => expect(localClient.ingestCommit).toHaveBeenCalled())
    expect(localClient.ingestCommit.mock.calls[0][0].mode).toBe('add')
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
  })

  it('tells the director to use the main computer when the handler refuses on a Client', async () => {
    // The refusal names the one thing they can do about it; the generic
    // "not something the app recognised" fallback would bury that.
    localClient.ingestCommit.mockRejectedValue(new Error('Import can only be run on the main computer.'))
    await uploadFile()
    await userEvent.click(screen.getByText(/Add \d+ record/))
    await userEvent.click(await screen.findByText(/Commit \d+ record/))
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
    for (const name of ['Units', 'Groups', 'Days', 'Time Blocks', 'Activities']) {
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
describe('ImportScreen — Replace warning names Fixed Events and separates the irreversible item (T68)', () => {
  it('warns about cleared Fixed Events with a live count when the camp has anchors, and never says "anchor"', async () => {
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
    expect(screen.getByText(textNode(/Your\s*3\s*Fixed Events will/))).toBeTruthy()
    expect(screen.getByText(/They are recoverable from Trash/)).toBeTruthy()
    expect(container.textContent).not.toMatch(/anchor/i)
  })

  it('does not warn about Fixed Events when the camp has none', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'tiers') return Promise.resolve([{ id: 't1', cohort_id: 'cohort-1' }])
      return Promise.resolve([])
    })
    await uploadFile()
    await userEvent.click(screen.getByText(/Replace them/))
    expect(screen.queryByText(/Fixed Event/)).toBeNull()
  })

  it('uses singular phrasing for exactly one Fixed Event', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'tiers') return Promise.resolve([{ id: 't1', cohort_id: 'cohort-1' }])
      if (entity === 'anchor_activities') return Promise.resolve([{ id: 'a1' }])
      return Promise.resolve([])
    })
    await uploadFile()
    await userEvent.click(screen.getByText(/Replace them/))
    expect(screen.getByText(textNode(/Your\s*1\s*Fixed Event will/))).toBeTruthy()
    expect(screen.getByText(/It is recoverable from Trash/)).toBeTruthy()
    expect(screen.queryByText(/Fixed Events will/)).toBeNull()
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
    // Fixed Events sentence, i.e. the two are not sharing one box.
    let dangerContainer = irreversibleLabel.parentElement
    while (dangerContainer && !/color-mix\(in srgb, var\(--danger\)/.test(dangerContainer.getAttribute('style') || '')) {
      dangerContainer = dangerContainer.parentElement
    }
    expect(dangerContainer).toBeTruthy()
    expect(dangerContainer.textContent).toMatch(/saved schedule version/)
    expect(dangerContainer.textContent).not.toMatch(/Fixed Event/)

    const fixedEventsLine = screen.getByText(/Fixed Event will/)
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
    expect(screen.queryByText(/Fixed Event/)).toBeNull()
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
    expect(screen.queryByText(/Fixed Event/)).toBeNull()
    expect(screen.queryByText(/saved schedule version/)).toBeNull()
    expect(screen.queryByText(/Day Override/)).toBeNull()
  })
})
