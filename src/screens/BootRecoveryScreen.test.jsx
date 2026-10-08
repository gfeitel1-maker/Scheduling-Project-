// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

const quitApp = vi.fn()
vi.mock('../localClient', () => ({ localClient: { quitApp: (...a) => quitApp(...a) } }))

const { default: BootRecoveryScreen } = await import('./BootRecoveryScreen')

const RAW = /SQLITE|db_|Error:|stack|\.key\.enc|SHORESH_/

const CASES = [
  [{ code: 'db_unreadable' }, "This device can't open its camp data", /every other device paired to this camp has a full copy/],
  [{ code: 'db_migration_interrupted', backupPath: '/Users/x/camp.sqlite.pre-migration-1.bak' },
    "An update to this camp's file was interrupted", /Your original copy is safe and was not changed/],
  [{ code: 'db_migration_interrupted' }, "An update to this camp's file was interrupted", /no saved copy was found on this computer/],
  [{ code: 'db_key_file_missing' }, "This device's camp key is missing", /rather than make a new one/],
  [{ code: 'db_key_guard_unreadable' }, "Shoresh can't read its own files", /file-permissions problem/],
  [{ code: 'keychain_unavailable' }, "This computer's secure storage isn't available", /Restart the computer/],
]

describe('BootRecoveryScreen', () => {
  it.each(CASES)('%j shows its title and body with no raw error text', (failure, title, body) => {
    const { container } = render(<BootRecoveryScreen failure={failure} />)
    expect(screen.getByText(title)).toBeTruthy()
    expect(container.textContent).toMatch(body)
    expect(screen.getByText('Details were saved for whoever helps you with Shoresh.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Quit Shoresh' })).toBeTruthy()
    expect(screen.queryByText('Try again')).toBeNull()
    const visible = container.textContent.replace(failure.backupPath || '', '')
    expect(visible).not.toMatch(RAW)
  })

  it('shows the backup path only when there is one', () => {
    const { unmount } = render(<BootRecoveryScreen failure={CASES[1][0]} />)
    expect(screen.getByText(CASES[1][0].backupPath)).toBeTruthy()
    unmount()
    const { container } = render(<BootRecoveryScreen failure={CASES[2][0]} />)
    expect(container.textContent).not.toMatch(/pre-migration/)
  })

  it('Quit Shoresh calls the quit IPC', () => {
    render(<BootRecoveryScreen failure={{ code: 'db_unreadable' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Quit Shoresh' }))
    expect(quitApp).toHaveBeenCalledTimes(1)
  })
})
