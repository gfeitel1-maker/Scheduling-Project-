// @vitest-environment jsdom
//
// The "Hand hosting to <device>" control on a Devices row (docs/adr/2026-10-09-host-succession-simple.md,
// UI). Appears only for a device the host reports as eligible (admin, on the LAN); progress and the
// result live on the control itself; never a banner, never a disabled coming-soon control.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import HostHandoffControl from './HostHandoffControl'

afterEach(cleanup)

const device = { id: 'dev-s', name: 'Office iMac' }
const idle = { isHost: true, eligibleDeviceIds: ['dev-s'], handoff: null, lastResult: null }

describe('HostHandoffControl', () => {
  it('renders nothing for a device that is not eligible, or when this computer is not the host', () => {
    const { container, rerender } = render(<HostHandoffControl device={device} status={{ ...idle, eligibleDeviceIds: [] }} onStart={vi.fn()} />)
    expect(container.textContent).toBe('')
    rerender(<HostHandoffControl device={device} status={{ ...idle, isHost: false }} onStart={vi.fn()} />)
    expect(container.textContent).toBe('')
    rerender(<HostHandoffControl device={device} status={null} onStart={vi.fn()} />)
    expect(container.textContent).toBe('')
  })

  it('offers "Hand hosting to <device>" and starts the handoff for that device', async () => {
    const onStart = vi.fn()
    render(<HostHandoffControl device={device} status={idle} onStart={onStart} />)
    await userEvent.click(screen.getByRole('button', { name: 'Hand hosting to Office iMac' }))
    expect(onStart).toHaveBeenCalledWith('dev-s')
  })

  it.each([
    ['offered', 'Waiting for Office iMac to confirm…'],
    ['sent', 'Sending to Office iMac…'],
    ['committed', 'Restarting…'],
  ])('shows %s progress as text on the control, in place of the button', (state, text) => {
    render(<HostHandoffControl device={device} status={{ ...idle, handoff: { role: 'giver', peerDeviceId: 'dev-s', state } }} onStart={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toContain(text)
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('under reduced motion the same progress is plain text, with no moving bar', () => {
    window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })
    const { container } = render(<HostHandoffControl device={device} status={{ ...idle, handoff: { role: 'giver', peerDeviceId: 'dev-s', state: 'sent' } }} onStart={vi.fn()} />)
    expect(screen.getByRole('status').textContent).toContain('Sending to Office iMac…')
    expect(container.querySelector('.shoresh-indeterminate-fill')).toBeNull()
    delete window.matchMedia
  })

  it('a handoff in progress to ANOTHER device hides this row\'s control (one handoff at a time)', () => {
    render(<HostHandoffControl device={device} status={{ ...idle, handoff: { role: 'giver', peerDeviceId: 'other', state: 'offered' } }} onStart={vi.fn()} />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('after a failure, states plainly that nothing changed, on the control, and lets the director try again', async () => {
    const onStart = vi.fn()
    render(<HostHandoffControl device={device} status={{ ...idle, lastResult: { ok: false, reason: 'timed_out', peerDeviceId: 'dev-s' } }} onStart={onStart} />)
    expect(screen.getByRole('status').textContent).toBe('Handoff did not complete. Office iMac was not changed; this computer is still the host.')
    await userEvent.click(screen.getByRole('button', { name: 'Hand hosting to Office iMac' }))
    expect(onStart).toHaveBeenCalledWith('dev-s')
  })

  it('a failure for a different device is not shown on this row', () => {
    render(<HostHandoffControl device={device} status={{ ...idle, lastResult: { ok: false, reason: 'timed_out', peerDeviceId: 'other' } }} onStart={vi.fn()} />)
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('after this computer committed, a successor that could not activate is reported on the control, even though this computer is no longer the host', () => {
    const status = {
      isHost: false, eligibleDeviceIds: [],
      handoff: { role: 'giver', peerDeviceId: 'dev-s', state: 'committed' },
      lastResult: { ok: false, reason: 'activation_failed', peerDeviceId: 'dev-s' },
    }
    render(<HostHandoffControl device={device} status={status} onStart={vi.fn()} />)
    const text = screen.getByRole('status').textContent
    expect(text).toContain('Office iMac received hosting but could not finish setting it up')
    expect(text).toContain('Keep both computers open')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('is never an alert banner and never a disabled placeholder', () => {
    render(<HostHandoffControl device={device} status={{ ...idle, lastResult: { ok: false, reason: 'x', peerDeviceId: 'dev-s' } }} onStart={vi.fn()} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('button').disabled).toBe(false)
  })
})
