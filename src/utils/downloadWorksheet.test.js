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
    const fixedEvents = [{ id: 'fe-1', name: 'Mifkad' }]
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
