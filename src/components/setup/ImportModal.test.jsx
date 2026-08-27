// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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

  it('applies the warning-row style token (not a hardcoded hex) to warned rows', () => {
    render(<ImportModal step="preview" title="Import Preview" columns={cols} rows={rows}
      readyCount={1} warnCount={1} importing={false}
      onConfirm={() => {}} onCancel={() => {}}
      renderCell={(r, c) => (c.key === 'status' ? (r.warning || 'Ready') : (r[c.key] || '—'))} />)
    const warnedRow = screen.getByText('Missing label').closest('tr')
    expect(warnedRow.style.background).not.toMatch(/#fff8e7/i)
  })
})
