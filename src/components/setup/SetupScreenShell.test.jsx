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
})
