// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { createRef } from 'react'
import SetupScreenShell, { SETUP_MAX_WIDTH } from './SetupScreenShell'

const base = {
  countLabel: '5 days', role: 'admin', fileInputRef: createRef(),
  onFileChange: () => {}, screenKey: 'days', onNavigate: () => {}, error: null,
}

describe('SetupScreenShell', () => {
  it('renders count, children, and Next', () => {
    render(<SetupScreenShell {...base} actions={{}}><div>BODY</div></SetupScreenShell>)
    expect(screen.queryByText('5 days')).not.toBeNull()
    expect(screen.queryByText('BODY')).not.toBeNull()
    expect(screen.queryByText('Time Blocks →')).not.toBeNull()
  })

  it('hides Delete All when no onDeleteAll is given', () => {
    render(<SetupScreenShell {...base} actions={{ onDownloadTemplate: () => {} }}><div /></SetupScreenShell>)
    expect(screen.queryByText('Delete All')).toBeNull()
    expect(screen.queryByText('Download Template')).not.toBeNull()
  })

  it('shows Delete All when provided, disabled for non-admin', () => {
    render(<SetupScreenShell {...base} role="staff" actions={{ onDeleteAll: () => {} }}><div /></SetupScreenShell>)
    const btn = screen.getByText('Delete All')
    expect(btn.disabled).toBe(true)
  })

  it('renders the error banner when error is set', () => {
    render(<SetupScreenShell {...base} error="Nope" actions={{}}><div /></SetupScreenShell>)
    expect(screen.queryByText('Nope')).not.toBeNull()
  })

  it('renders a cohortPicker node when supplied', () => {
    render(<SetupScreenShell {...base} actions={{}} cohortPicker={<div>PICKER</div>}><div /></SetupScreenShell>)
    expect(screen.queryByText('PICKER')).not.toBeNull()
  })

  it('applies the one shared setup width (820) on every screen', () => {
    const { container } = render(<SetupScreenShell {...base} actions={{}}><div /></SetupScreenShell>)
    expect(SETUP_MAX_WIDTH).toBe(820)
    expect(container.firstChild.style.maxWidth).toBe('820px')
  })

  it('renders no footer when there is neither a Next nor a utility', () => {
    const { container } = render(<SetupScreenShell countLabel="2 sets" error={null}><div>BODY</div></SetupScreenShell>)
    expect(screen.queryByText('2 sets')).not.toBeNull()
    expect(container.firstChild.lastChild.textContent).toBe('BODY')
    expect(screen.queryByRole('button')).toBeNull()
  })

  // Consistency audit 2026-10-12 C10: one width; a screen cannot widen itself.
  it('ignores a per-screen maxWidth', () => {
    const { container } = render(<SetupScreenShell {...base} maxWidth={1200} actions={{}}><div /></SetupScreenShell>)
    expect(container.firstChild.style.maxWidth).toBe('820px')
  })

  // C2/C4: the forward link follows the sidebar's setup order, and the last setup screen leads to the schedule.
  it('links to the next setup screen in sidebar order, and from the last one to the schedule', () => {
    const onNavigate = vi.fn()
    const { unmount } = render(<SetupScreenShell {...base} screenKey="locations" onNavigate={onNavigate} actions={{}}><div /></SetupScreenShell>)
    fireEvent.click(screen.getByText('Activities →'))
    expect(onNavigate).toHaveBeenCalledWith('activities')
    unmount()
    render(<SetupScreenShell {...base} screenKey="specialevents" onNavigate={onNavigate} actions={{}}><div /></SetupScreenShell>)
    fireEvent.click(screen.getByText('Schedule →'))
    expect(onNavigate).toHaveBeenLastCalledWith('schedule')
  })

  // Owner finding 2026-10-12: one week bar, first on the screen, only where the data is per-week.
  it('renders the week bar first when given week props, and none without them', () => {
    const week = { weekId: 'w1', weeks: [{ id: 'w1', name: 'Week 1' }], onSelectWeek: () => {}, exclusionCount: 0, totalCount: 3, entityLabel: 'groups' }
    const { container, unmount } = render(<SetupScreenShell {...base} week={week} actions={{}}><div>BODY</div></SetupScreenShell>)
    expect(container.firstChild.firstChild.textContent).toMatch(/Week 1/)
    unmount()
    render(<SetupScreenShell {...base} actions={{}}><div>BODY</div></SetupScreenShell>)
    expect(screen.queryByText(/Week 1/)).toBeNull()
  })

  it('disables Delete All when deleteAllDisabled is true, even for admins', () => {
    render(<SetupScreenShell {...base} role="admin" actions={{ onDeleteAll: () => {}, deleteAllDisabled: true }}><div /></SetupScreenShell>)
    const btn = screen.getByText('Delete All')
    expect(btn.disabled).toBe(true)
  })

  it('leaves Delete All enabled for admins when deleteAllDisabled is not set', () => {
    render(<SetupScreenShell {...base} role="admin" actions={{ onDeleteAll: () => {} }}><div /></SetupScreenShell>)
    const btn = screen.getByText('Delete All')
    expect(btn.disabled).toBe(false)
  })

  // Prominence is state-derived, not a per-screen literal: solid (full opacity)
  // when the button is enabled, muted (S.buttonDisabled's opacity) when it is disabled.
  it('renders Delete All prominent (full opacity) when enabled', () => {
    render(<SetupScreenShell {...base} role="admin" actions={{ onDeleteAll: () => {} }}><div /></SetupScreenShell>)
    const btn = screen.getByText('Delete All')
    expect(btn.disabled).toBe(false)
    expect(btn.style.opacity === '' || btn.style.opacity === '1').toBe(true)
  })

  it('renders Delete All muted (the shared disabled opacity) when disabled via deleteAllDisabled', () => {
    render(<SetupScreenShell {...base} role="admin" actions={{ onDeleteAll: () => {}, deleteAllDisabled: true }}><div /></SetupScreenShell>)
    const btn = screen.getByText('Delete All')
    expect(btn.disabled).toBe(true)
    expect(btn.style.opacity).toBe('0.45')
  })

  it('renders Delete All muted (the shared disabled opacity) when disabled for a non-admin', () => {
    render(<SetupScreenShell {...base} role="staff" actions={{ onDeleteAll: () => {} }}><div /></SetupScreenShell>)
    const btn = screen.getByText('Delete All')
    expect(btn.disabled).toBe(true)
    expect(btn.style.opacity).toBe('0.45')
  })
})
