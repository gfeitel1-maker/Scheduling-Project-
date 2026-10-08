// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

let device
vi.mock('./hooks/useDeviceMode', () => ({ useDeviceMode: () => device }))
vi.mock('./localClient', () => ({
  localClient: { reportSmokeReady: vi.fn(), quitApp: vi.fn(), onOpRejected: vi.fn(() => () => {}) },
}))

const { default: App } = await import('./App')

describe('App error phase', () => {
  it('renders BootRecoveryScreen when a boot failure is present', () => {
    device = { phase: 'error', error: null, bootFailure: { code: 'db_unreadable' } }
    render(<App />)
    expect(screen.getByText("This device can't open its camp data")).toBeTruthy()
    expect(screen.queryByText('Try again')).toBeNull()
  })

  it('still renders the generic card with Try again otherwise', () => {
    device = { phase: 'error', error: 'kaboom', bootFailure: null, retry: vi.fn() }
    render(<App />)
    expect(screen.getByText('Something went wrong')).toBeTruthy()
    expect(screen.getByText('Try again')).toBeTruthy()
  })
})
