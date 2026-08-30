// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import SetupScreenShell from './SetupScreenShell'

const base = {
  countLabel: '5 days', role: 'admin', fileInputRef: createRef(),
  onFileChange: () => {}, nextLabel: 'Next: X →', onNext: () => {}, error: null,
}

describe('SetupScreenShell', () => {
  it('renders count, children, and Next', () => {
    render(<SetupScreenShell {...base} actions={{}}><div>BODY</div></SetupScreenShell>)
    expect(screen.queryByText('5 days')).not.toBeNull()
    expect(screen.queryByText('BODY')).not.toBeNull()
    expect(screen.queryByText('Next: X →')).not.toBeNull()
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

  it('applies the default maxWidth of 680 when none is passed', () => {
    const { container } = render(<SetupScreenShell {...base} actions={{}}><div /></SetupScreenShell>)
    expect(container.firstChild.style.maxWidth).toBe('680px')
  })

  it('applies a custom maxWidth when passed', () => {
    const { container } = render(<SetupScreenShell {...base} maxWidth={820} actions={{}}><div /></SetupScreenShell>)
    expect(container.firstChild.style.maxWidth).toBe('820px')
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
  // when the button is enabled, muted (opacity 0.6) when it is disabled.
  it('renders Delete All prominent (full opacity) when enabled', () => {
    render(<SetupScreenShell {...base} role="admin" actions={{ onDeleteAll: () => {} }}><div /></SetupScreenShell>)
    const btn = screen.getByText('Delete All')
    expect(btn.disabled).toBe(false)
    expect(btn.style.opacity === '' || btn.style.opacity === '1').toBe(true)
  })

  it('renders Delete All muted (opacity 0.6) when disabled via deleteAllDisabled', () => {
    render(<SetupScreenShell {...base} role="admin" actions={{ onDeleteAll: () => {}, deleteAllDisabled: true }}><div /></SetupScreenShell>)
    const btn = screen.getByText('Delete All')
    expect(btn.disabled).toBe(true)
    expect(btn.style.opacity).toBe('0.6')
  })

  it('renders Delete All muted (opacity 0.6) when disabled for a non-admin', () => {
    render(<SetupScreenShell {...base} role="staff" actions={{ onDeleteAll: () => {} }}><div /></SetupScreenShell>)
    const btn = screen.getByText('Delete All')
    expect(btn.disabled).toBe(true)
    expect(btn.style.opacity).toBe('0.6')
  })
})
