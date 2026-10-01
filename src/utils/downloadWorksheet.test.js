// SLICE B2 (board q-export-columns-do-not-round-trip) — fixed_events is outside
// INGESTIBLE_ENTITIES (no S4b/commitPlan committer), so runWorksheetDownload must fetch it
// separately or exportWorkbook's "Fixed Events" sheet ships empty every time.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const listMock = vi.fn()
const getCampMock = vi.fn()
const latestOpSeqMock = vi.fn()
const downloadWorkbookMock = vi.fn()

vi.mock('../localClient', () => ({
  localClient: { list: (...args) => listMock(...args), getCamp: (...args) => getCampMock(...args), latestOpSeq: (...args) => latestOpSeqMock(...args) },
}))
vi.mock('./exportWorkbook.js', () => ({
  downloadWorkbook: (...args) => downloadWorkbookMock(...args),
}))

import { runWorksheetDownload } from './downloadWorksheet.js'
import { INGESTIBLE_ENTITIES } from '../ingest/extractEntities'

describe('runWorksheetDownload — fixed_events feeds the Fixed Events sheet', () => {
  beforeEach(() => {
    listMock.mockReset().mockResolvedValue([])
    getCampMock.mockReset().mockResolvedValue({ id: 'camp-1' })
    latestOpSeqMock.mockReset().mockResolvedValue(10)
    downloadWorkbookMock.mockReset()
  })

  it('fetches fixed_events (outside INGESTIBLE_ENTITIES) and passes it through to downloadWorkbook', async () => {
    const fixedEvents = [{ id: 'fe-1', name: 'Mifkad', cohort_id: 'coh-1' }]
    listMock.mockImplementation((entity) => Promise.resolve(entity === 'fixed_events' ? fixedEvents : []))

    await runWorksheetDownload('coh-1')

    expect(listMock).toHaveBeenCalledWith('fixed_events')
    expect(downloadWorkbookMock).toHaveBeenCalledTimes(1)
    const args = downloadWorkbookMock.mock.calls[0][0]
    expect(args.fixed_events).toEqual(fixedEvents)
    // Every INGESTIBLE_ENTITIES entry is still fetched too — this is additive, not a replacement.
    for (const entity of INGESTIBLE_ENTITIES) expect(listMock).toHaveBeenCalledWith(entity)
  })

  it('a failed fixed_events fetch degrades to empty, like every other entity', async () => {
    listMock.mockImplementation((entity) => entity === 'fixed_events' ? Promise.reject(new Error('boom')) : Promise.resolve([]))

    await runWorksheetDownload('coh-1')

    const args = downloadWorkbookMock.mock.calls[0][0]
    expect(args.fixed_events).toEqual([])
  })
})

describe('runWorksheetDownload — cohort scoping (board q-export-columns-do-not-round-trip, B2b cohort fix a)', () => {
  beforeEach(() => {
    listMock.mockReset()
    getCampMock.mockReset().mockResolvedValue({ id: 'camp-1' })
    latestOpSeqMock.mockReset().mockResolvedValue(10)
    downloadWorkbookMock.mockReset()
  })

  it('scopes tiers, time_blocks and fixed_events to the active cohort, leaving camp-wide entities untouched', async () => {
    const rowsByEntity = {
      tiers: [{ id: 't1', cohort_id: 'coh-1' }, { id: 't2', cohort_id: 'coh-2' }],
      time_blocks: [{ id: 'b1', cohort_id: 'coh-1' }, { id: 'b2', cohort_id: 'coh-2' }],
      fixed_events: [{ id: 'e1', cohort_id: 'coh-1' }, { id: 'e2', cohort_id: 'coh-2' }],
      groups: [{ id: 'g1' }],
      activities: [{ id: 'a1' }],
      days_of_operation: [{ id: 'd1' }],
      locations: [{ id: 'l1' }],
      cohorts: [{ id: 'coh-1' }, { id: 'coh-2' }],
    }
    listMock.mockImplementation((entity) => Promise.resolve(rowsByEntity[entity] ?? []))

    await runWorksheetDownload('coh-1')

    const args = downloadWorkbookMock.mock.calls[0][0]
    expect(args.tiers).toEqual([{ id: 't1', cohort_id: 'coh-1' }])
    expect(args.time_blocks).toEqual([{ id: 'b1', cohort_id: 'coh-1' }])
    expect(args.fixed_events).toEqual([{ id: 'e1', cohort_id: 'coh-1' }])
    // camp-wide entities are passed through unfiltered
    expect(args.groups).toEqual(rowsByEntity.groups)
    expect(args.activities).toEqual(rowsByEntity.activities)
    expect(args.days_of_operation).toEqual(rowsByEntity.days_of_operation)
    expect(args.locations).toEqual(rowsByEntity.locations)
  })
})
