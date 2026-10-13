// @vitest-environment jsdom
// Director test 2026-10-12: the last import's undo stays on Roots until the next import, says which file
// and when, says what Undo keeps, and confirms before undoing.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../localClient', () => ({ localClient: { lastImportUndo: vi.fn(), ingestUndo: vi.fn() } }))
import { localClient } from '../localClient'
import LastImportUndo from './LastImportUndo'

beforeEach(() => {
  localClient.lastImportUndo.mockReset()
  localClient.ingestUndo.mockReset()
})

describe('LastImportUndo', () => {
  it('shows nothing when there is no import to undo', async () => {
    localClient.lastImportUndo.mockResolvedValue(null)
    const { container } = render(<LastImportUndo />)
    await waitFor(() => expect(localClient.lastImportUndo).toHaveBeenCalled())
    expect(container.textContent).toBe('')
  })

  it('names the file, says what Undo keeps, confirms, and undoes the named run', async () => {
    localClient.lastImportUndo.mockResolvedValue({ importRunId: 'run-1', fileName: 'campB.txt', committedAt: new Date().toISOString() })
    localClient.ingestUndo.mockResolvedValue({ deleted: [{}], kept: [{}, {}] })
    render(<LastImportUndo />)
    expect(await screen.findByText(/^Last import: campB\.txt, today/)).toBeTruthy()
    expect(screen.getByText(/Anything you have edited since stays as it is/)).toBeTruthy()
    fireEvent.click(screen.getByText('Undo last import'))
    fireEvent.click(await screen.findByText('Undo import'))
    await waitFor(() => expect(localClient.ingestUndo).toHaveBeenCalledWith(expect.objectContaining({ importRunId: 'run-1' })))
    expect(await screen.findByText('Import undone. 2 things you changed after importing were kept.')).toBeTruthy()
  })
})
