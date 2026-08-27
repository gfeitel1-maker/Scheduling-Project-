// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { useState } from 'react'
import ImportModal from './ImportModal'

const cols = [{ key: 'label', label: 'Label' }, { key: 'status', label: 'Status' }]
const rows = [
  { label: 'Monday', warning: null },
  { label: '', warning: 'Missing label' },
]

describe('ImportModal', () => {
  it('renders ready/warn counts and the rows in preview', () => {
    render(<ImportModal step="preview" title="Import Preview" columns={cols} rows={rows}
      readyCount={1} warnCount={1} importing={false}
      onConfirm={() => {}} onCancel={() => {}} renderCell={(r, c) => r[c.key] || '—'} />)
    expect(screen.queryByText(/1 ready/)).not.toBeNull()
    expect(screen.queryByText(/1 with warnings/)).not.toBeNull()
  })

  it('Escape triggers onCancel', () => {
    const onCancel = vi.fn()
    render(<ImportModal step="preview" title="Import Preview" columns={cols} rows={rows}
      readyCount={1} warnCount={1} importing={false}
      onConfirm={() => {}} onCancel={onCancel} renderCell={(r, c) => r[c.key] || '—'} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('moves focus into the modal on open', () => {
    render(<ImportModal step="preview" title="Import Preview" columns={cols} rows={rows}
      readyCount={1} warnCount={1} importing={false}
      onConfirm={() => {}} onCancel={() => {}} renderCell={(r, c) => r[c.key] || '—'} />)
    const dialog = screen.getByRole('dialog')
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it('renders the done panel with added/skipped', () => {
    render(<ImportModal step="done" title="Import Complete" columns={cols} rows={[]}
      readyCount={0} warnCount={0} result={{ added: 3, skipped: 1 }} importing={false}
      onConfirm={() => {}} onCancel={() => {}} renderCell={() => null} />)
    expect(screen.queryByText(/3 added/)).not.toBeNull()
    expect(screen.queryByText(/1 skipped/)).not.toBeNull()
  })

  it('renders nothing when step is null', () => {
    const { container } = render(<ImportModal step={null} title="" columns={cols} rows={[]}
      readyCount={0} warnCount={0} importing={false}
      onConfirm={() => {}} onCancel={() => {}} renderCell={() => null} />)
    expect(container.firstChild).toBeNull()
  })

  it('re-runs the focus effect once per open, not per host re-render, and always calls the latest onCancel', () => {
    const onCancelCalls = []
    // Simulates a host screen: passes an inline onCancel and re-renders with
    // a NEW function identity each time (e.g. `importing` toggling during
    // confirm), without the modal itself closing and reopening.
    function Host() {
      const [tick, setTick] = useState(0)
      return (
        <>
          <button onClick={() => setTick(t => t + 1)}>rerender-host</button>
          <ImportModal step="preview" title="Import Preview" columns={cols} rows={rows}
            readyCount={1} warnCount={1} importing={false}
            onConfirm={() => {}} onCancel={() => onCancelCalls.push(tick)}
            renderCell={(r, c) => r[c.key] || '—'} />
        </>
      )
    }
    render(<Host />)

    const cancelBtn = screen.getByText('Cancel')
    cancelBtn.focus()
    expect(document.activeElement).toBe(cancelBtn)

    // Host re-renders with a new onCancel identity; the focus effect must not
    // re-run (it depends on [step] only) — focus should stay put, not jump
    // back to the primary "Import" button.
    fireEvent.click(screen.getByText('rerender-host'))
    expect(document.activeElement).toBe(cancelBtn)

    // Escape still reaches the LATEST onCancel closure, via the ref.
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancelCalls).toEqual([1])
  })

  it('restores focus to the previously-focused element on close', () => {
    function Host() {
      const [step, setStep] = useState(null)
      return (
        <>
          <button id="opener" onClick={() => setStep('preview')}>Opener</button>
          <ImportModal step={step} title="Import Preview" columns={cols} rows={rows}
            readyCount={1} warnCount={1} importing={false}
            onConfirm={() => {}} onCancel={() => setStep(null)}
            renderCell={(r, c) => r[c.key] || '—'} />
        </>
      )
    }
    render(<Host />)
    const opener = document.getElementById('opener')
    opener.focus()
    expect(document.activeElement).toBe(opener)

    // Opening the modal (still while `opener` is focused) captures it as the
    // pre-open focus target; closing via Escape must restore it.
    fireEvent.click(opener)
    expect(screen.getByRole('dialog')).not.toBeNull()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).toBe(opener)
  })

  it('applies the warning-row style token (not a hardcoded hex) to warned rows', () => {
    render(<ImportModal step="preview" title="Import Preview" columns={cols} rows={rows}
      readyCount={1} warnCount={1} importing={false}
      onConfirm={() => {}} onCancel={() => {}}
      renderCell={(r, c) => (c.key === 'status' ? (r.warning || 'Ready') : (r[c.key] || '—'))} />)
    const warnedRow = screen.getByText('Missing label').closest('tr')
    expect(warnedRow.style.background).not.toMatch(/#fff8e7/i)
  })
})
