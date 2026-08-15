// @vitest-environment jsdom
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ConfirmDangerDialog from './ConfirmDangerDialog'

describe('ConfirmDangerDialog', () => {
  it('renders title, body, recovery and the confirm label', () => {
    render(
      <ConfirmDangerDialog
        title="Delete all things?"
        body="This removes every thing."
        recovery="They can be restored from Trash."
        confirmLabel="Delete All Things"
        busy={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    )
    expect(screen.getByText('Delete all things?')).toBeTruthy()
    expect(screen.getByText('This removes every thing.')).toBeTruthy()
    expect(screen.getByText('They can be restored from Trash.')).toBeTruthy()
    expect(screen.getByText('Delete All Things')).toBeTruthy()
  })

  it('omits body/recovery paragraphs when not provided', () => {
    render(
      <ConfirmDangerDialog
        title="Delete this program?"
        confirmLabel="Delete Program"
        busy={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    )
    expect(screen.getByText('Delete this program?')).toBeTruthy()
    expect(document.querySelector('p')).toBeNull()
  })

  it('fires onConfirm and onCancel', () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(
      <ConfirmDangerDialog title="Delete?" confirmLabel="Delete" busy={false} onConfirm={onConfirm} onCancel={onCancel} />
    )
    fireEvent.click(screen.getByText('Delete'))
    expect(onConfirm).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByText('Cancel'))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('cancels on Escape and on backdrop click', () => {
    const onCancel = vi.fn()
    render(
      <ConfirmDangerDialog title="Delete?" confirmLabel="Delete" busy={false} onConfirm={() => {}} onCancel={onCancel} />
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('Delete?').closest('[style*="position: fixed"]'))
    expect(onCancel).toHaveBeenCalledTimes(2)
  })

  it('does not cancel on Escape or backdrop click while busy, and disables both buttons with a Working… label', () => {
    const onCancel = vi.fn()
    render(
      <ConfirmDangerDialog title="Delete?" confirmLabel="Delete" busy={true} onConfirm={() => {}} onCancel={onCancel} />
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.click(screen.getByText('Delete?').closest('[style*="position: fixed"]'))
    expect(onCancel).not.toHaveBeenCalled()

    expect(screen.getByText('Working…').closest('button').disabled).toBe(true)
    expect(screen.getByText('Cancel').closest('button').disabled).toBe(true)
  })

  it('guards against a double-click firing onConfirm more than once before busy propagates', () => {
    const onConfirm = vi.fn()
    render(
      <ConfirmDangerDialog title="Delete?" confirmLabel="Delete" busy={false} onConfirm={onConfirm} onCancel={() => {}} />
    )
    const button = screen.getByText('Delete')
    fireEvent.click(button)
    fireEvent.click(button)
    fireEvent.click(button)
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })

  it('resets the double-click guard once busy returns to false, allowing a retry after a failed delete', () => {
    const onConfirm = vi.fn()
    const { rerender } = render(
      <ConfirmDangerDialog title="Delete?" confirmLabel="Delete" busy={false} onConfirm={onConfirm} onCancel={() => {}} />
    )
    fireEvent.click(screen.getByText('Delete'))
    expect(onConfirm).toHaveBeenCalledTimes(1)

    // Delete started, then failed — caller flips busy true then back to false.
    rerender(<ConfirmDangerDialog title="Delete?" confirmLabel="Delete" busy={true} onConfirm={onConfirm} onCancel={() => {}} />)
    rerender(<ConfirmDangerDialog title="Delete?" confirmLabel="Delete" busy={false} onConfirm={onConfirm} onCancel={() => {}} />)

    fireEvent.click(screen.getByText('Delete'))
    expect(onConfirm).toHaveBeenCalledTimes(2)
  })
})
