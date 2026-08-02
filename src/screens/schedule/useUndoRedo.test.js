// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useUndoRedo } from './useUndoRedo'

// A recording undo/redo entry: undo/redo push their names onto a shared log so
// a test can assert the exact call order without touching a real repository.
function entry(log, name) {
  return {
    description: name,
    undo: vi.fn(async () => { log.push(`undo:${name}`) }),
    redo: vi.fn(async () => { log.push(`redo:${name}`) }),
  }
}

function setup() {
  const setActionError = vi.fn()
  const hook = renderHook(() => useUndoRedo({ setActionError }))
  return { ...hook, setActionError }
}

describe('useUndoRedo', () => {
  it('pushUndo appends to the undo stack and clears the redo stack', () => {
    const { result } = setup()
    const log = []
    act(() => result.current.pushUndo(entry(log, 'a')))
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.redoStack).toHaveLength(0)

    // A fresh action after an undo (which populated redo) must wipe redo.
    act(() => result.current.pushUndo(entry(log, 'b')))
    expect(result.current.undoStack).toHaveLength(2)
  })

  it('handleUndo runs the last entry.undo(), moves it to redo, and handleRedo reverses that', async () => {
    const { result } = setup()
    const log = []
    act(() => result.current.pushUndo(entry(log, 'a')))

    await act(async () => { await result.current.handleUndo() })
    expect(log).toEqual(['undo:a'])
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(1)

    await act(async () => { await result.current.handleRedo() })
    expect(log).toEqual(['undo:a', 'redo:a'])
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.redoStack).toHaveLength(0)
  })

  it('pushing a new entry after an undo clears the redo stack', async () => {
    const { result } = setup()
    const log = []
    act(() => result.current.pushUndo(entry(log, 'a')))
    await act(async () => { await result.current.handleUndo() })
    expect(result.current.redoStack).toHaveLength(1)

    act(() => result.current.pushUndo(entry(log, 'b')))
    expect(result.current.redoStack).toHaveLength(0)
  })

  it('handleUndo / handleRedo are no-ops on empty stacks', async () => {
    const { result } = setup()
    await act(async () => { await result.current.handleUndo() })
    await act(async () => { await result.current.handleRedo() })
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(0)
  })

  it('caps the undo stack at 50, dropping the oldest entry', () => {
    const { result } = setup()
    const log = []
    act(() => {
      for (let i = 0; i < 55; i++) result.current.pushUndo(entry(log, `e${i}`))
    })
    expect(result.current.undoStack).toHaveLength(50)
    // Oldest five (e0..e4) were dropped; e5 is now the base.
    expect(result.current.undoStack[0].description).toBe('e5')
    expect(result.current.undoStack[49].description).toBe('e54')
  })

  it('surfaces a failed undo via setActionError and leaves the stacks untouched', async () => {
    const { result, setActionError } = setup()
    const bad = {
      description: 'boom',
      undo: vi.fn(async () => { throw new Error('write failed') }),
      redo: vi.fn(),
    }
    act(() => result.current.pushUndo(bad))
    await act(async () => { await result.current.handleUndo() })
    expect(setActionError).toHaveBeenCalledTimes(1)
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.redoStack).toHaveLength(0)
  })

  it('reset() clears both stacks', async () => {
    const { result } = setup()
    const log = []
    act(() => result.current.pushUndo(entry(log, 'a')))
    await act(async () => { await result.current.handleUndo() })
    expect(result.current.redoStack).toHaveLength(1)

    act(() => result.current.reset())
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(0)
  })

  it('Ctrl/Cmd+Z triggers undo and Ctrl+Shift+Z triggers redo via the keyboard listener', async () => {
    const { result } = setup()
    const log = []
    act(() => result.current.pushUndo(entry(log, 'a')))

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }))
    })
    expect(log).toEqual(['undo:a'])

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true }))
    })
    expect(log).toEqual(['undo:a', 'redo:a'])
  })
})
