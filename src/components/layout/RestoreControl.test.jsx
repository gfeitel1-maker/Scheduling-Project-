// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

vi.mock('../../localClient', () => ({
  localClient: { pickRestoreBackup: vi.fn(), restoreProject: vi.fn() },
}))
import { localClient } from '../../localClient'
import RestoreControl from './RestoreControl'
import Sidebar from './Sidebar'

const COUNTS = { cohorts: 1, tiers: 4, groups: 14, days: 5, timeblocks: 6, activities: 8, recurringevents: 0, dayoverrides: 0, locations: 0 }
const DATE = '2026-03-14T15:00:00.000Z'

beforeEach(() => {
  vi.clearAllMocks()
  localClient.pickRestoreBackup.mockResolvedValue({ backupDate: DATE })
  localClient.restoreProject.mockResolvedValue({ restored: true })
})

async function pick() {
  render(<RestoreControl />)
  fireEvent.click(screen.getByRole('button', { name: 'Restore from backup…' }))
  await screen.findByText(/Replaces this camp's data with the backup from/)
}

describe('RestoreControl', () => {
  it('is shown to admins and hidden from other roles in the sidebar', () => {
    const props = { current: 'groups', onNavigate() {}, counts: COUNTS, campName: 'C', syncStatus: null, offerShown: false, setOfferShown() {} }
    const { unmount } = render(<Sidebar {...props} role="admin" />)
    expect(screen.queryByRole('button', { name: 'Restore from backup…' })).not.toBeNull()
    unmount()
    render(<Sidebar {...props} role="viewer" />)
    expect(screen.queryByRole('button', { name: 'Restore from backup…' })).toBeNull()
  })

  it('confirms once with the backup date, and restores only after confirm', async () => {
    await pick()
    expect(screen.getByText(/the backup from March 14, 2026\./)).toBeTruthy()
    expect(localClient.restoreProject).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await screen.findByText('Restored from backup.')
    expect(localClient.restoreProject).toHaveBeenCalledTimes(1)
  })

  it('does not restore when cancelled at the confirm', async () => {
    await pick()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(localClient.restoreProject).not.toHaveBeenCalled()
    expect(screen.queryByText(/Replaces this camp's data/)).toBeNull()
  })

  it('does nothing when the file picker is cancelled', async () => {
    localClient.pickRestoreBackup.mockResolvedValue({ canceled: true })
    render(<RestoreControl />)
    fireEvent.click(screen.getByRole('button', { name: 'Restore from backup…' }))
    await waitFor(() => expect(localClient.pickRestoreBackup).toHaveBeenCalled())
    expect(screen.queryByText(/Replaces this camp's data/)).toBeNull()
    expect(localClient.restoreProject).not.toHaveBeenCalled()
  })

  it('says in plain words when a restore fails', async () => {
    localClient.restoreProject.mockResolvedValue({ error: 'project_switch_in_progress' })
    await pick()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await screen.findByText(/Another project change is in progress/)
  })

  it('names restore_failed and a thrown error as failures', async () => {
    localClient.restoreProject.mockResolvedValue({ error: 'restore_failed', message: 'disk full' })
    await pick()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await screen.findByText(/Restore failed — disk full/)
  })

  it('only claims data is unchanged for the copy-stage failure', async () => {
    localClient.restoreProject.mockResolvedValue({ error: 'restore_failed', message: 'disk full' })
    await pick()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    await screen.findByText(/Your current data was not changed/)
  })

  it('tells the director the prior data is in the backups folder when the restore failed after replacing it', async () => {
    localClient.restoreProject.mockResolvedValue({ error: 'restore_incomplete', message: 'bad file' })
    await pick()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).not.toMatch(/not changed/)
    expect(alert.textContent).toMatch(/backups folder/)
  })

  it('says nothing was restored when the safety copy could not be written', async () => {
    localClient.restoreProject.mockResolvedValue({ error: 'backup_failed', message: 'disk full' })
    await pick()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/copy of your current data could not be saved/)
    expect(alert.textContent).toMatch(/nothing was restored/i)
  })

  it('reports a file that cannot be used', async () => {
    localClient.pickRestoreBackup.mockResolvedValue({ error: 'schema_too_new', message: 'Backup requires a newer version of Shoresh (schema v99).' })
    render(<RestoreControl />)
    fireEvent.click(screen.getByRole('button', { name: 'Restore from backup…' }))
    await screen.findByText(/newer version of Shoresh/)
    expect(localClient.restoreProject).not.toHaveBeenCalled()
  })
})
