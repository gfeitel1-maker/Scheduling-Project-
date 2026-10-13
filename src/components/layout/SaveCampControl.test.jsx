// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'

vi.mock('../../localClient', () => ({ localClient: { saveCampFile: vi.fn() } }))
import { localClient } from '../../localClient'
import SaveCampControl from './SaveCampControl'
import Sidebar from './Sidebar'

const COUNTS = { cohorts: 1, tiers: 4, groups: 14, days: 5, timeblocks: 6, activities: 8, recurringevents: 0, dayoverrides: 0, locations: 0 }
const OK = { ok: true, fileName: 'Camp Probe.shoresh-camp', counts: { groups: 14, activities: 8, locations: 3 }, total: 99 }

beforeEach(() => {
  vi.clearAllMocks()
  localClient.saveCampFile.mockResolvedValue(OK)
})

describe('SaveCampControl', () => {
  it('is shown to admins and hidden from other roles in the sidebar', () => {
    const props = { current: 'groups', onNavigate() {}, counts: COUNTS, campName: 'C', syncStatus: null, offerShown: false, setOfferShown() {} }
    const { unmount } = render(<Sidebar {...props} role="admin" />)
    expect(screen.queryByRole('button', { name: 'Save whole camp' })).not.toBeNull()
    unmount()
    render(<Sidebar {...props} role="viewer" />)
    expect(screen.queryByRole('button', { name: 'Save whole camp' })).toBeNull()
  })

  it('confirms first, with the unprotected-file warning and what is left out, and saves nothing yet', () => {
    render(<SaveCampControl />)
    fireEvent.click(screen.getByRole('button', { name: 'Save whole camp' }))
    expect(screen.getByText("This file isn't protected — keep it somewhere private.")).toBeTruthy()
    expect(screen.getByText("Camper lists and elective choices aren't included; import them again after opening.")).toBeTruthy()
    expect(localClient.saveCampFile).not.toHaveBeenCalled()
  })

  it('cancelling the confirm saves nothing', () => {
    render(<SaveCampControl />)
    fireEvent.click(screen.getByRole('button', { name: 'Save whole camp' }))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(localClient.saveCampFile).not.toHaveBeenCalled()
    expect(screen.queryByText(/This file isn't protected/)).toBeNull()
  })

  it('shows progress in place, then names the file and what it holds', async () => {
    let finish
    localClient.saveCampFile.mockReturnValue(new Promise((r) => { finish = r }))
    render(<SaveCampControl />)
    fireEvent.click(screen.getByRole('button', { name: 'Save whole camp' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose where to save' }))
    expect((await screen.findByRole('status')).textContent).toMatch(/Saving your camp/)
    finish(OK)
    const done = await screen.findByText(/Camp Probe\.shoresh-camp/)
    expect(done.textContent).toMatch(/14 groups/)
    expect(done.textContent).toMatch(/8 activities/)
    expect(done.textContent).toMatch(/3 locations/)
    expect(screen.queryByText(/Saving your camp/)).toBeNull()
  })

  it('returns quietly to the button when the save dialog is cancelled', async () => {
    localClient.saveCampFile.mockResolvedValue({ ok: false, reason: 'canceled' })
    render(<SaveCampControl />)
    fireEvent.click(screen.getByRole('button', { name: 'Save whole camp' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose where to save' }))
    await screen.findByRole('button', { name: 'Save whole camp' })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says a failed save failed, in plain words', async () => {
    localClient.saveCampFile.mockResolvedValue({ ok: false, reason: 'write_failed', message: 'The file could not be saved (EACCES). Pick a different folder and try again.' })
    render(<SaveCampControl />)
    fireEvent.click(screen.getByRole('button', { name: 'Save whole camp' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose where to save' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/could not be saved/)
  })

  it('says a thrown save failed too (a rejected call is never silent)', async () => {
    localClient.saveCampFile.mockRejectedValue(new Error('admin role required'))
    render(<SaveCampControl />)
    fireEvent.click(screen.getByRole('button', { name: 'Save whole camp' }))
    fireEvent.click(screen.getByRole('button', { name: 'Choose where to save' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/couldn.t be saved/i)
  })
})
