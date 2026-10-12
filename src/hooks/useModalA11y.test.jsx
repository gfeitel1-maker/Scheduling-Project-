// @vitest-environment jsdom
//
// Design audit 2026-10-12 #2: dialogs are keyboard-first. One shared hook gives every overlay a
// dialog role, focus on its safe action when it opens, Escape to cancel (topmost dialog only), and
// focus back where it was when it closes.
import { describe, it, expect, vi } from 'vitest'
import { useRef, useState } from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { useModalA11y } from './useModalA11y'
import ConfirmRegenModal from '../components/schedule/ConfirmRegenModal'

function Opener({ children }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      {open && children(() => setOpen(false))}
    </>
  )
}

describe('useModalA11y via ConfirmRegenModal', () => {
  it('is a modal dialog, focuses Cancel on open, cancels on Escape, and restores focus on close', () => {
    const onConfirm = vi.fn()
    render(<Opener>{(close) => <ConfirmRegenModal role="admin" onConfirm={onConfirm} onCancel={close} />}</Opener>)
    const opener = screen.getByText('Open')
    opener.focus()
    fireEvent.click(opener)

    const dialog = screen.getByRole('dialog')
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(document.activeElement).toBe(screen.getByText('Cancel'))

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onConfirm).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(opener)
  })
})

function Dialog({ label, onCancel }) {
  const cancelRef = useRef()
  const a11y = useModalA11y({ onCancel, initialFocusRef: cancelRef })
  return <div {...a11y} aria-label={label}><button ref={cancelRef} onClick={onCancel}>Cancel {label}</button></div>
}

describe('useModalA11y stacking', () => {
  it('Escape closes only the topmost dialog', () => {
    const outer = vi.fn(), inner = vi.fn()
    render(<><Dialog label="outer" onCancel={outer} /><Dialog label="inner" onCancel={inner} /></>)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(inner).toHaveBeenCalledTimes(1)
    expect(outer).not.toHaveBeenCalled()
  })

  it('without an initial focus target, the dialog itself takes focus', () => {
    function Bare() { const a11y = useModalA11y({ onCancel: () => {} }); return <div {...a11y}>text</div> }
    render(<Bare />)
    expect(document.activeElement).toBe(screen.getByRole('dialog'))
  })
})

// Guard the choke point, not the instances: any component that renders the shared overlay must use
// the hook, so a new dialog cannot ship without Escape and focus handling.
describe('every overlay dialog (S.overlay or a full-screen fixed scrim) uses useModalA11y', () => {
  it('no source file renders S.overlay without calling useModalA11y', () => {
    const root = path.resolve(__dirname, '..')
    const files = []
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.jsx?$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p) } }
    walk(root)
    const missing = files.filter((f) => { const s = fs.readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, ''); return (/\bS\.overlay\b/.test(s) || /position: 'fixed',\s*\n\s*inset: 0/.test(s)) && !/\buseModalA11y\(|<ModalCard\b/.test(s) }).map((f) => path.relative(root, f))
      .filter((f) => f !== path.join('styles', 'shared.js')) // defines S.overlay; renders no dialog
    expect(missing).toEqual([])
  })
})
