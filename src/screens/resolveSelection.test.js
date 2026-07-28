import { describe, it, expect } from 'vitest'
import { resolveSelection } from './resolveSelection'

// T10 — every drop in Day View re-ran loadAll(), which unconditionally reset
// the selection to the first day. The user was thrown back to Monday after
// editing Tuesday.

const days = [{ id: 'mon' }, { id: 'tue' }, { id: 'wed' }]

describe('resolveSelection', () => {
  it('keeps the current selection when it is still valid', () => {
    // The regression this exists to prevent: a reload must not move the user.
    expect(resolveSelection('tue', days)).toBe('tue')
  })

  it('defaults to the first item on genuine first load', () => {
    // Selection state starts as null in ScheduleScreen.
    expect(resolveSelection(null, days)).toBe('mon')
  })

  it('falls back to the first item when the selection was deleted', () => {
    expect(resolveSelection('fri', days)).toBe('mon')
  })

  it('returns null when there is nothing to select', () => {
    // Matches the initial state, so the UI's existing empty handling applies
    // rather than leaving a dangling id for a row that no longer exists.
    expect(resolveSelection('tue', [])).toBeNull()
    expect(resolveSelection(null, [])).toBeNull()
  })

  it('is stable across repeated reloads', () => {
    // loadAll() runs on every op-applied event. Applying this repeatedly must
    // not drift — that drift was the bug.
    let selected = resolveSelection(null, days)
    expect(selected).toBe('mon')
    selected = resolveSelection('wed', days)
    for (let i = 0; i < 10; i++) selected = resolveSelection(selected, days)
    expect(selected).toBe('wed')
  })

  it('survives a reload where unrelated items changed around the selection', () => {
    // A drop elsewhere reorders or adds rows; the selected day is untouched.
    expect(resolveSelection('tue', [{ id: 'wed' }, { id: 'tue' }, { id: 'thu' }])).toBe('tue')
  })

  it('tolerates a missing or malformed list without throwing', () => {
    // loadAll builds these from IPC results that can legitimately be empty.
    expect(resolveSelection('tue', undefined)).toBeNull()
    expect(resolveSelection('tue', null)).toBeNull()
    expect(resolveSelection('tue', [null, undefined, { id: 'tue' }])).toBe('tue')
  })
})
