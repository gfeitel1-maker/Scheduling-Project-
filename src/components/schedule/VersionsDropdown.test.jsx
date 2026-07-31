// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import VersionsDropdown from './VersionsDropdown'

// Newest first, exactly as ScheduleScreen sorts them.
const RECOVERED = {
  id: 'snap-recovered',
  name: 'Recovered week — found during an update',
  is_auto: false,
  created_at: '2026-07-30T10:00:00.000Z',
  restorable: true,
  on_screen: false,
}
const AUTO_SAVE = {
  id: 'snap-auto',
  name: null,
  is_auto: true,
  created_at: '2026-07-29T10:00:00.000Z',
  restorable: true,
  on_screen: false,
}
const NAMED = {
  id: 'snap-named',
  name: 'V2 second',
  is_auto: false,
  created_at: '2026-07-28T10:00:00.000Z',
  restorable: true,
  on_screen: false,
}

function renderOpen(snapshots, props = {}) {
  const onRestore = vi.fn()
  render(
    <VersionsDropdown
      snapshots={snapshots}
      isOpen
      role="admin"
      onToggle={() => {}}
      onRestore={onRestore}
      onSaveNamed={() => {}}
      onRenameAutoSave={() => {}}
      onDelete={() => {}}
      {...props}
    />
  )
  return { onRestore }
}

function rowFor(text) {
  return screen.getByText(text).closest('div[style*="border-bottom"]')
}

describe('VersionsDropdown', () => {
  it('offers Restore on the week preserved by an update, even though it is newest', () => {
    // v26 writes its snapshot last, so the preserved week sorts first. The old
    // positional rule called the first row "current" and hid Restore — the week
    // the migration deleted the rows for could not be brought back at all.
    const { onRestore } = renderOpen([RECOVERED, AUTO_SAVE, NAMED])
    const row = rowFor('Recovered week — found during an update')
    const restore = within(row).getByRole('button', { name: 'Restore' })
    expect(restore.disabled).toBe(false)
    fireEvent.click(restore)
    expect(onRestore).toHaveBeenCalledWith(RECOVERED)
  })

  it('does not label the newest version as being on screen', () => {
    renderOpen([RECOVERED, AUTO_SAVE, NAMED])
    expect(screen.queryByText('on screen now')).toBeNull()
  })

  it('labels the version that matches the schedule on screen, wherever it sits in the list', () => {
    renderOpen([RECOVERED, AUTO_SAVE, { ...NAMED, on_screen: true }])
    const row = rowFor('V2 second')
    expect(within(row).getByText('on screen now')).toBeTruthy()
    expect(rowFor('Recovered week — found during an update').textContent).not.toContain('on screen now')
  })

  it('still offers Restore on the version that is already on screen', () => {
    // Restoring what you already have is a harmless no-op, and removing the
    // button is how the preserved week became unreachable.
    const { onRestore } = renderOpen([{ ...RECOVERED, on_screen: true }, NAMED])
    const row = rowFor('Recovered week — found during an update')
    fireEvent.click(within(row).getByRole('button', { name: 'Restore' }))
    expect(onRestore).toHaveBeenCalled()
  })

  it('offers rename on an auto-save whatever its position', () => {
    renderOpen([{ ...AUTO_SAVE, on_screen: true }, NAMED])
    expect(within(rowFor('Auto-save')).getByRole('button', { name: 'rename' })).toBeTruthy()
  })

  it('shows the whole version name rather than clipping it', () => {
    renderOpen([RECOVERED])
    const name = screen.getByText('Recovered week — found during an update')
    expect(name.style.textOverflow).not.toBe('ellipsis')
    expect(name.style.whiteSpace).not.toBe('nowrap')
  })

  it('keeps an unrestorable version labelled Empty and disabled', () => {
    renderOpen([{ ...NAMED, restorable: false }])
    const btn = screen.getByRole('button', { name: 'Empty' })
    expect(btn.disabled).toBe(true)
  })
})
