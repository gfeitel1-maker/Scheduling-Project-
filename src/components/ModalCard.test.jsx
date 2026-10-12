// @vitest-environment jsdom
//
// Design audit 2026-10-12 #6: a dialog's card lifts in while its scrim only fades, and on close a
// snapshot of the overlay fades out instead of the dialog vanishing in one frame. The snapshot is
// visual only: aria-hidden, in a closed shadow root (so page queries never see its text), gone after.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, act } from '@testing-library/react'
import ModalCard from './ModalCard'
import { S } from '../styles/shared'

afterEach(() => { vi.useRealTimers(); document.querySelectorAll('[data-exit-snapshot]').forEach((n) => n.remove()) })

function Harness({ swap = false }) {
  const [open, setOpen] = useState(true)
  const [step, setStep] = useState(1)
  return (
    <>
      <button onClick={() => setOpen(false)}>close it</button>
      <button onClick={() => setStep((n) => n + 1)}>next step</button>
      {open && (
        <div style={S.overlay}>
          <ModalCard key={swap ? step : 'one'} onCancel={() => setOpen(false)}>
            <span>Dialog body {step}</span>
          </ModalCard>
        </div>
      )}
    </>
  )
}

const snapshots = () => document.querySelectorAll('[data-exit-snapshot]')
const flush = () => act(async () => { await Promise.resolve() })

describe('ModalCard exit snapshot', () => {
  it('closing leaves an aria-hidden snapshot that page queries cannot see, removed shortly after', async () => {
    vi.useFakeTimers()
    render(<Harness />)
    fireEvent.click(screen.getByText('close it'))
    await flush()
    expect(snapshots()).toHaveLength(1)
    expect(snapshots()[0].getAttribute('aria-hidden')).toBe('true')
    expect(screen.queryByText(/Dialog body/)).toBeNull()
    act(() => { vi.advanceTimersByTime(450) })
    expect(snapshots()).toHaveLength(0)
  })

  it('a card swapped inside a scrim that stays (re-key, next step) leaves no snapshot', async () => {
    render(<Harness swap />)
    fireEvent.click(screen.getByText('next step'))
    await flush()
    expect(screen.getByText('Dialog body 2')).not.toBeNull()
    expect(snapshots()).toHaveLength(0)
  })
})

describe('ModalCard enter motion', () => {
  it('the card lifts (transform transition); enter={false} leaves a self-animated card alone', () => {
    render(<div style={S.overlay}><ModalCard aria-label="a"><span>a</span></ModalCard><ModalCard enter={false} aria-label="b" style={{ color: 'red' }}><span>b</span></ModalCard></div>)
    const [a, b] = screen.getAllByRole('dialog')
    expect(a.style.transition).toMatch(/transform/)
    expect(b.style.transition).toBe('')
  })
})
