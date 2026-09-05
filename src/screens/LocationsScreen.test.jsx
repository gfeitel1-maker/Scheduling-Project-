// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { deriveLocationId } from '../../electron/ops/locationId'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
    listByScope: vi.fn(),
    write: vi.fn(),
    deleteEntity: vi.fn(),
    previewDelete: vi.fn(),
    deleteRecord: vi.fn(),
    mergeLocation: vi.fn(),
    listMigrationReviews: vi.fn(),
    dismissMigrationReviews: vi.fn(),
    locationCapacityProvenance: vi.fn(),
  },
}))

vi.mock('xlsx', () => ({
  utils: {
    book_new: vi.fn(() => ({})),
    book_append_sheet: vi.fn(),
    sheet_to_json: vi.fn(() => []),
    aoa_to_sheet: vi.fn(() => ({})),
  },
  writeFile: vi.fn(),
  read: vi.fn(() => ({ SheetNames: ['Sheet1'], Sheets: { Sheet1: {} } })),
}))

import LocationsScreen from './LocationsScreen'
import { localClient } from '../localClient'
import * as XLSX from 'xlsx'

const CAMP_ID = 'camp-1'

function location(overrides = {}) {
  return {
    id: 'loc-1',
    camp_id: CAMP_ID,
    name: 'Pool',
    capacity: 1,
    notes: null,
    sort_order: 1,
    ...overrides,
  }
}

function activity(overrides = {}) {
  return { id: 'act-1', camp_id: CAMP_ID, name: 'Free Swim', location_id: 'loc-1', ...overrides }
}

function review(overrides = {}) {
  return {
    id: 'review-1',
    camp_id: CAMP_ID,
    location_id: 'loc-1',
    name: 'Pool',
    kind: 'was_unlimited',
    detail: { seededCapacity: 1 },
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => 'token-abc',
    setItem: () => {},
    removeItem: () => {},
  })
  vi.stubGlobal('crypto', { randomUUID: () => 'new-location-id' })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  localClient.list.mockReset().mockImplementation((entity) => {
    if (entity === 'locations') return Promise.resolve([])
    if (entity === 'activities') return Promise.resolve([])
    return Promise.resolve([])
  })
  localClient.listByScope.mockReset().mockResolvedValue([])
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.deleteEntity.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.previewDelete.mockReset().mockResolvedValue({
    ok: true, entity: 'locations', entity_id: 'loc-1', name: 'Pool', ref_count: 0, activities: [],
  })
  localClient.deleteRecord.mockReset().mockResolvedValue({ ok: true, cleared: 0 })
  localClient.mergeLocation.mockReset().mockResolvedValue({ ok: true, cleared: 0, reassigned_activity_ids: [] })
  localClient.listMigrationReviews.mockReset().mockResolvedValue([])
  localClient.dismissMigrationReviews.mockReset().mockResolvedValue({ ok: true, dismissed: 0 })
  localClient.locationCapacityProvenance.mockReset().mockResolvedValue({})
  XLSX.utils.sheet_to_json.mockReset().mockReturnValue([])
  XLSX.read.mockReset().mockReturnValue({ SheetNames: ['Sheet1'], Sheets: { Sheet1: {} } })
})

describe('LocationsScreen', () => {
  it('renders an in-table empty row and keeps the toolbar + inline-add row reachable at zero locations', async () => {
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await waitFor(() => expect(screen.queryByText('No locations yet')).not.toBeNull())
    expect(screen.queryByText(/Add a location below to add your first one/)).not.toBeNull()
    // The table now always renders (in-table empty-row pattern), so the inline
    // add row and the Import toolbar are reachable even with no locations.
    expect(screen.queryByRole('table')).not.toBeNull()
    expect(screen.queryByText('0 locations')).not.toBeNull()
    expect(screen.queryByText('Import from Excel')).not.toBeNull()
    expect(screen.queryByPlaceholderText('e.g. Pool, Gym, Beit Midrash')).not.toBeNull()
    // The old calm-card "Add your first location" CTA + Add Location card are gone.
    expect(screen.queryByText('Add your first location')).toBeNull()
    expect(screen.queryByText('Add Location')).toBeNull()
  })

  it('loads locations scoped to campId and shows the populated table', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') {
        return Promise.resolve([
          location({ id: 'loc-1', name: 'Pool', capacity: 3 }),
          location({ id: 'loc-other', name: 'Wrong Camp', camp_id: 'other-camp' }),
        ])
      }
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await waitFor(() => expect(screen.queryByText('1 location')).not.toBeNull())
    expect(localClient.list).toHaveBeenCalledWith('locations')
    expect(screen.queryByText('Pool')).not.toBeNull()
    expect(screen.queryByText('3 groups')).not.toBeNull()
    expect(screen.queryByText('Wrong Camp')).toBeNull()
  })

  it('adds a location via the inline row, writing name first, then camp_id/capacity/notes', async () => {
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('No locations yet')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('e.g. Pool, Gym, Beit Midrash'), { target: { value: 'Gym' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    const [, , , firstField] = localClient.write.mock.calls[0]
    expect(firstField).toBe('name')
    const fieldsWritten = localClient.write.mock.calls.map((c) => c[3])
    expect(fieldsWritten).toEqual(expect.arrayContaining(['name', 'camp_id', 'capacity', 'notes']))
  })

  it('the inline add row defaults capacity to 1 and writes it', async () => {
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('No locations yet')).not.toBeNull())

    fireEvent.change(screen.getByPlaceholderText('e.g. Pool, Gym, Beit Midrash'), { target: { value: 'Gym' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    const capacityCall = localClient.write.mock.calls.find((c) => c[3] === 'capacity')
    expect(capacityCall[4]).toBe(1)
  })

  it('the inline add row writes the chosen kind and clears after a successful add', async () => {
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('No locations yet')).not.toBeNull())

    const nameInput = screen.getByPlaceholderText('e.g. Pool, Gym, Beit Midrash')
    fireEvent.change(nameInput, { target: { value: 'Pool' } })
    // The inline row's kind <select> — the only select on the empty screen.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'pool' } })
    fireEvent.click(screen.getByText('+ Add'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    const kindCall = localClient.write.mock.calls.find((c) => c[3] === 'kind')
    expect(kindCall).toBeTruthy()
    expect(kindCall[4]).toBe('pool')
    // Row clears back to empty after a successful add so it stays put for the next entry.
    await waitFor(() => expect(nameInput.value).toBe(''))
  })

  it('the inline add row does not commit an empty name', async () => {
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('No locations yet')).not.toBeNull())

    // The "+ Add" button is disabled while name is blank, and clicking it is a no-op.
    const addBtn = screen.getByText('+ Add')
    expect(addBtn.disabled).toBe(true)
    fireEvent.click(addBtn)

    expect(localClient.write).not.toHaveBeenCalled()
  })

  it('imports locations from Excel through the shared importRows path, skipping dupes and warnings', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location({ id: 'loc-1', name: 'Pool' })])
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    const file = new File(['dummy'], 'locations.xlsx')
    const fileInput = document.querySelector('input[type="file"]')
    const rows = [
      { name: 'pool', capacity: 2, kind: 'pool' },        // duplicate (case-insensitive) -> skipped
      { name: '', capacity: 1, kind: '' },                 // missing name -> warning -> skipped
      { name: 'Gym', capacity: 4, kind: 'court' },         // new, valid
    ]
    XLSX.utils.sheet_to_json.mockReturnValue(rows)

    await userEvent.upload(fileInput, file)

    // The case-insensitive dupe ('pool') is not parse-flagged — it looks ready
    // and is only skipped at confirm-time by importRows' duplicateCheck. So the
    // preview counts 2 ready (pool + Gym) and 1 with warnings (the blank name).
    await waitFor(() => expect(screen.queryByText(/1 with warnings/)).not.toBeNull())
    fireEvent.click(screen.getByText(/Import 2/))

    await waitFor(() => expect(screen.queryByText(/1 added/)).not.toBeNull())
    const namesWritten = localClient.write.mock.calls.filter((c) => c[3] === 'name').map((c) => c[4])
    expect(namesWritten).toEqual(['Gym'])
    const capsWritten = localClient.write.mock.calls.filter((c) => c[3] === 'capacity').map((c) => c[4])
    expect(capsWritten).toEqual([4])
  })

  it('edits capacity via the stepper in the inline edit row and saves the new value', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location({ capacity: 1 })])
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByText('Edit'))
    // The Add card renders its own stepper too, so scope to the first
    // (edit row) instance — the edit row renders before the Add card in DOM order.
    const increase = screen.getAllByLabelText('Increase')[0]
    fireEvent.click(increase)
    fireEvent.click(increase)
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      const capacityCall = localClient.write.mock.calls.find((c) => c[3] === 'capacity')
      expect(capacityCall).toBeTruthy()
      expect(capacityCall[4]).toBe(3)
    })
  })

  it('the stepper never goes below 1, even via direct typed input', async () => {
    // T119: starts at 3 (not 1) so the clamped-to-1 result is a genuine
    // change and a capacity op is actually written — save() now omits
    // capacity from the payload entirely when it hasn't changed.
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location({ capacity: 3 })])
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByText('Edit'))
    const input = screen.getAllByLabelText('Groups at once')[0]
    fireEvent.change(input, { target: { value: '0' } })
    fireEvent.blur(input) // CapacityStepper only commits (and clamps) on blur/Enter/+-click
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      const capacityCall = localClient.write.mock.calls.find((c) => c[3] === 'capacity')
      expect(capacityCall).toBeTruthy()
      expect(capacityCall[4]).toBe(1)
    })
  })

  // T119 — a quiet per-row marker on the capacity cell for a location whose
  // capacity was never director-confirmed (still the importer's default).
  // T119 (redirect) — mirrors ActivitiesScreen's RuleProvenanceDot pattern
  // instead of a bare tooltip dot: a button with a "Provenance:" aria-label,
  // shown only for a location whose capacity is unconfirmed (quiet by
  // default for a confirmed value, same as Activities hides the dot
  // entirely for a hand-created row with no import evidence).
  it('shows a capacity provenance dot for an unconfirmed location, not for a confirmed one', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') {
        return Promise.resolve([
          location({ id: 'loc-1', name: 'Pool' }),
          location({ id: 'loc-2', name: 'Gym' }),
        ])
      }
      return Promise.resolve([])
    })
    localClient.locationCapacityProvenance.mockResolvedValue({ 'loc-1': 'unconfirmed', 'loc-2': 'confirmed' })

    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    await waitFor(() => expect(screen.queryByRole('button', { name: /Capacity provenance: inferred/i })).not.toBeNull())
    // Only one dot — Gym's capacity is confirmed, so it stays quiet.
    expect(screen.getAllByRole('button', { name: /Capacity provenance:/i })).toHaveLength(1)
  })

  it('opens a popover with the Confirmed/Observed/Inferred vocabulary and a Confirm action, which re-writes capacity and clears the dot', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location({ id: 'loc-1', name: 'Pool', capacity: 3 })])
      return Promise.resolve([])
    })
    localClient.locationCapacityProvenance.mockResolvedValue({ 'loc-1': 'unconfirmed' })

    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByRole('button', { name: /Capacity provenance:/i }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).queryByText('Inferred')).not.toBeNull()

    // After confirming, the next provenance read reports it confirmed.
    localClient.locationCapacityProvenance.mockResolvedValue({ 'loc-1': 'confirmed' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }))

    await waitFor(() => expect(localClient.write).toHaveBeenCalledWith('token-abc', 'locations', 'loc-1', 'capacity', 3))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Capacity provenance:/i })).toBeNull())
  })

  // T119 — save() must not re-write capacity when the director never touched
  // it: opening the row to edit an unrelated field (name) and saving would
  // otherwise silently stamp capacity as source='human', laundering an
  // unconfirmed imported value the instant a director edits anything else on
  // the row.
  it('editing only the name and saving does not write capacity at all', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location({ capacity: 1 })])
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByText('Edit'))
    const nameInputs = screen.getAllByDisplayValue('Pool')
    fireEvent.change(nameInputs[0], { target: { value: 'Pool Building' } })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    const capacityCall = localClient.write.mock.calls.find((c) => c[3] === 'capacity')
    expect(capacityCall).toBeUndefined()
    const nameCall = localClient.write.mock.calls.find((c) => c[3] === 'name')
    expect(nameCall[4]).toBe('Pool Building')
  })

  it('changing the capacity value and saving DOES write capacity', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location({ capacity: 1 })])
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByText('Edit'))
    const increase = screen.getAllByLabelText('Increase')[0]
    fireEvent.click(increase)
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => {
      const capacityCall = localClient.write.mock.calls.find((c) => c[3] === 'capacity')
      expect(capacityCall).toBeTruthy()
      expect(capacityCall[4]).toBe(2)
    })
  })

  // M3c — delete now routes through previewDelete/DeleteRecordDialog/
  // deleteRecord (the shared host path, D2), replacing the bespoke in-screen
  // unbind-then-deleteEntity flow M3a shipped.
  // docs/adr/2026-08-15-locations-merge-and-delete-rehome.md
  it('shows the bound-activity count before deleting, then deletes through the shared host path', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location()])
      return Promise.resolve([])
    })
    localClient.previewDelete.mockResolvedValue({
      ok: true, entity: 'locations', entity_id: 'loc-1', name: 'Pool', ref_count: 2,
      activities: [{ id: 'act-1', name: 'Free Swim', max_groups_per_slot: 1 }, { id: 'act-2', name: 'Swim Lessons', max_groups_per_slot: 1 }],
    })
    localClient.deleteRecord.mockResolvedValue({ ok: true, cleared: 2, reassigned_activity_ids: [] })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => expect(localClient.previewDelete).toHaveBeenCalledWith('locations', 'loc-1'))
    await waitFor(() => expect(screen.queryByText(/Delete .Pool./)).not.toBeNull())
    expect(screen.queryByText(/2 activities use Pool right now/)).not.toBeNull()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
    expect(localClient.deleteRecord).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Delete and clear 2 activities'))

    await waitFor(() => expect(localClient.deleteRecord).toHaveBeenCalledWith('locations', 'loc-1', 2))
  })

  it('shows honest copy when nothing is bound to the location', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location()])
      return Promise.resolve([])
    })
    localClient.previewDelete.mockResolvedValue({
      ok: true, entity: 'locations', entity_id: 'loc-1', name: 'Pool', ref_count: 0, activities: [],
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => expect(screen.queryByText(/Nothing uses Pool right now/)).not.toBeNull())
  })

  it('shows an admin-role-specific error when previewDelete is rejected for a non-admin', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location()])
      return Promise.resolve([])
    })
    localClient.previewDelete.mockRejectedValue(new Error('admin role required'))
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))

    await waitFor(() => expect(screen.queryByText('Only an admin can delete locations.')).not.toBeNull())
  })

  it('cancels the delete confirm without deleting', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location()])
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete'))
    await waitFor(() => expect(screen.queryByText(/Delete .Pool./)).not.toBeNull())
    fireEvent.click(screen.getByText('Cancel'))

    expect(screen.queryByText(/Delete .Pool./)).toBeNull()
    expect(localClient.deleteRecord).not.toHaveBeenCalled()
  })

  it('disables Delete and Delete All for non-admin roles', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location()])
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="staff" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    expect(screen.getByText('Delete').disabled).toBe(true)
    expect(screen.getByText('Delete All').disabled).toBe(true)
  })

  it('shows a styled confirm modal (not window.confirm) before Delete All, and confirming deletes all camp-scoped locations', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location({ id: 'loc-1' }), location({ id: 'loc-2', name: 'Gym' })])
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))

    expect(window.confirm).not.toHaveBeenCalled()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.queryByText('Delete all locations?')).not.toBeNull())
    expect(screen.queryByText('They can be restored from Trash.')).not.toBeNull()

    fireEvent.click(screen.getByText('Delete All Locations'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledTimes(2))
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'locations', 'loc-1')
    expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'locations', 'loc-2')
  })

  it('cancels Delete All without deleting', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location()])
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByText('Delete All'))
    await waitFor(() => expect(screen.queryByText('Delete all locations?')).not.toBeNull())
    fireEvent.click(screen.getByText('Cancel'))

    expect(screen.queryByText('Delete all locations?')).toBeNull()
    expect(localClient.deleteEntity).not.toHaveBeenCalled()
  })

  it('navigates to Activities and to Fixed Events from its own Next chain', async () => {
    const onNavigate = vi.fn()
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={onNavigate} />)
    await waitFor(() => expect(screen.queryByText('No locations yet')).not.toBeNull())

    fireEvent.click(screen.getByText('← Back to Activities'))
    expect(onNavigate).toHaveBeenCalledWith('activities')

    fireEvent.click(screen.getByText('Next: Recurring Events →'))
    expect(onNavigate).toHaveBeenCalledWith('anchors')
  })

  it('shows a load-failure banner when localClient.list rejects', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.reject(new Error('boom'))
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await waitFor(() => expect(screen.queryByText(/Couldn't load your camp setup/)).not.toBeNull())
  })
})

// ---------------------------------------------------------------------------
// M3c — the first-run migration review region.
// docs/adr/2026-08-15-locations-merge-and-delete-rehome.md D3/D4/D5,
// docs/work/specs/2026-08-15-m3-locations-design.md Part 3.
// ---------------------------------------------------------------------------
describe('LocationsScreen: migration review region', () => {
  it('renders no region at all when the journal is empty (D-3.3)', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location()])
      return Promise.resolve([])
    })
    localClient.listMigrationReviews.mockResolvedValue([])
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    expect(screen.queryByText('These look like the same location')).toBeNull()
    expect(screen.queryByText(/Shoresh set a few capacities/)).toBeNull()
  })

  it('shows the advisory strip for capacity_disagreement and was_unlimited, numbers-only (D-2)', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location({ id: 'loc-1', name: 'Pool', capacity: 3 })])
      return Promise.resolve([])
    })
    localClient.listMigrationReviews.mockResolvedValue([
      review({
        id: 'r1', location_id: 'loc-1', name: 'Pool', kind: 'capacity_disagreement',
        detail: { declaredCaps: [1, 3], seededCapacity: 3 },
      }),
      review({ id: 'r2', location_id: 'loc-1', name: 'The Gym', kind: 'was_unlimited', detail: { seededCapacity: 1 } }),
    ])
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await waitFor(() => expect(screen.queryByText(/Shoresh set a few capacities/)).not.toBeNull())
    expect(screen.queryByText('2 to look at')).not.toBeNull()
    expect(screen.queryByText(/asked for different limits \(1 and 3 groups at once\)/)).not.toBeNull()
    expect(screen.queryByText(/Shoresh kept the most room: 3/)).not.toBeNull()
    expect(screen.queryByText(/had no limit set and is now 1 group at a time/)).not.toBeNull()
    // Numbers-only — never an activity name (D-2 owner decision).
    expect(screen.queryByText(/Swim Lessons/)).toBeNull()
  })

  it('"Looks right" writes the capacity and dismisses the review', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location({ id: 'loc-1', name: 'Pool', capacity: 3 })])
      return Promise.resolve([])
    })
    localClient.listMigrationReviews.mockResolvedValue([
      review({ id: 'r1', location_id: 'loc-1', name: 'Pool', kind: 'was_unlimited', detail: { seededCapacity: 1 } }),
    ])
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Looks right')).not.toBeNull())

    fireEvent.click(screen.getByText('Looks right'))

    await waitFor(() => expect(localClient.dismissMigrationReviews).toHaveBeenCalledWith(['r1']))
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'locations', 'loc-1', 'capacity', 3)
  })

  it('blocks the screen with the near-duplicate merge gate when unresolved (D-3)', async () => {
    const poolId = deriveLocationId(CAMP_ID, 'Pool')
    const poolLowerId = deriveLocationId(CAMP_ID, 'pool')
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') {
        return Promise.resolve([
          location({ id: poolId, name: 'Pool', capacity: 3 }),
          location({ id: poolLowerId, name: 'pool', capacity: 1 }),
        ])
      }
      if (entity === 'activities') {
        return Promise.resolve([
          activity({ id: 'act-1', location_id: poolId }),
          activity({ id: 'act-2', location_id: poolId }),
          activity({ id: 'act-3', location_id: poolLowerId }),
        ])
      }
      return Promise.resolve([])
    })
    localClient.listMigrationReviews.mockResolvedValue([
      review({ id: 'r1', location_id: poolId, name: 'Pool', kind: 'near_duplicate', detail: { variants: ['Pool', 'pool'] } }),
      review({ id: 'r2', location_id: poolLowerId, name: 'pool', kind: 'near_duplicate', detail: { variants: ['Pool', 'pool'] } }),
    ])
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await waitFor(() => expect(screen.queryByText('These look like the same location')).not.toBeNull())
    expect(screen.queryByText('1 location left to review')).not.toBeNull()
    // Default winner = most bound activities — "Pool" (2) over "pool" (1).
    expect(screen.queryByText(/2 activities here/)).not.toBeNull()
    expect(screen.queryByText(/1 activity here/)).not.toBeNull()
    // The advisory strip must not render while the gate is up.
    expect(screen.queryByText(/Shoresh set a few capacities/)).toBeNull()

    const mergeButton = screen.getByText('Merge into one location')
    expect(mergeButton.style.background).toBe('var(--primary)')
    expect(mergeButton.style.color).toBe('rgb(255, 255, 255)')
    fireEvent.click(mergeButton)

    await waitFor(() =>
      expect(localClient.mergeLocation).toHaveBeenCalledWith({
        loser_id: poolLowerId,
        winner_id: poolId,
        winner_capacity: 3,
        expected_ref_count: 1,
      })
    )
    await waitFor(() => expect(localClient.dismissMigrationReviews).toHaveBeenCalledWith(['r1', 'r2']))
  })

  it('"No — these are different locations" dismisses the group without merging', async () => {
    const poolId = deriveLocationId(CAMP_ID, 'Pool')
    const poolLowerId = deriveLocationId(CAMP_ID, 'pool')
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') {
        return Promise.resolve([location({ id: poolId, name: 'Pool' }), location({ id: poolLowerId, name: 'pool' })])
      }
      return Promise.resolve([])
    })
    localClient.listMigrationReviews.mockResolvedValue([
      review({ id: 'r1', location_id: poolId, name: 'Pool', kind: 'near_duplicate', detail: { variants: ['Pool', 'pool'] } }),
      review({ id: 'r2', location_id: poolLowerId, name: 'pool', kind: 'near_duplicate', detail: { variants: ['Pool', 'pool'] } }),
    ])
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)

    await waitFor(() => expect(screen.queryByText('These look like the same location')).not.toBeNull())
    fireEvent.click(screen.getByText('No — these are different locations'))

    await waitFor(() => expect(localClient.dismissMigrationReviews).toHaveBeenCalledWith(['r1', 'r2']))
    expect(localClient.mergeLocation).not.toHaveBeenCalled()
  })

  // BUG 2: refreshReviewData used to have two different failure semantics —
  // the mount effect swallowed a failure to [], but the shared function
  // handleMerge calls rethrew, so a refresh failure AFTER a merge that
  // genuinely succeeded surfaced a false "merge could not be completed"
  // error. Fixed by giving refreshReviewData ONE failure semantic (never
  // throws) that both callers share.
  it('a refreshReviewData failure after a successful merge does not surface a merge-failure error (BUG 2)', async () => {
    const poolId = deriveLocationId(CAMP_ID, 'Pool')
    const poolLowerId = deriveLocationId(CAMP_ID, 'pool')
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') {
        return Promise.resolve([
          location({ id: poolId, name: 'Pool', capacity: 3 }),
          location({ id: poolLowerId, name: 'pool', capacity: 1 }),
        ])
      }
      if (entity === 'activities') {
        return Promise.resolve([
          activity({ id: 'act-1', location_id: poolId }),
          activity({ id: 'act-2', location_id: poolId }),
          activity({ id: 'act-3', location_id: poolLowerId }),
        ])
      }
      return Promise.resolve([])
    })
    // First call is the mount effect (must succeed so the gate renders).
    // Second call is handleMerge's own post-merge refreshReviewData() call —
    // that one fails, even though the merge itself already succeeded.
    localClient.listMigrationReviews
      .mockResolvedValueOnce([
        review({ id: 'r1', location_id: poolId, name: 'Pool', kind: 'near_duplicate', detail: { variants: ['Pool', 'pool'] } }),
        review({ id: 'r2', location_id: poolLowerId, name: 'pool', kind: 'near_duplicate', detail: { variants: ['Pool', 'pool'] } }),
      ])
      .mockRejectedValueOnce(new Error('network blip'))

    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('These look like the same location')).not.toBeNull())

    fireEvent.click(screen.getByText('Merge into one location'))

    await waitFor(() =>
      expect(localClient.mergeLocation).toHaveBeenCalledWith({
        loser_id: poolLowerId,
        winner_id: poolId,
        winner_capacity: 3,
        expected_ref_count: 1,
      })
    )
    await waitFor(() => expect(localClient.dismissMigrationReviews).toHaveBeenCalledWith(['r1', 'r2']))
    await waitFor(() => expect(localClient.listMigrationReviews).toHaveBeenCalledTimes(2))

    expect(screen.queryByText(/That merge could not be completed/)).toBeNull()
  })

  it('D4 self-heal: hides a near_duplicate group whose loser location no longer exists', async () => {
    const poolId = deriveLocationId(CAMP_ID, 'Pool')
    // "pool" was already merged away (on this or another device) — only the
    // winner's row still exists.
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location({ id: poolId, name: 'Pool', capacity: 3 })])
      return Promise.resolve([])
    })
    localClient.listMigrationReviews.mockResolvedValue([
      review({ id: 'r1', location_id: poolId, name: 'Pool', kind: 'near_duplicate', detail: { variants: ['Pool', 'pool'] } }),
      review({ id: 'r2', location_id: 'loc-pool-lower', name: 'pool', kind: 'near_duplicate', detail: { variants: ['Pool', 'pool'] } }),
    ])
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    expect(screen.queryByText('These look like the same location')).toBeNull()
  })

  // FIX 1 (HIGH, safety-panel round): a 3+-variant near-duplicate group whose
  // batch merge fails partway through used to leave the gate trapped — the
  // failure handler only set gateError, never refreshed state, so the gate
  // kept offering an already-deleted loser and every retry died identically
  // on 'no-record' before ever reaching the loser that could still merge.
  // "these are different locations" was the only escape, permanently forfeiting
  // the un-merged variant. Fixed by refreshing on failure (self-heals the
  // gate onto the remaining mergeable variant) so a retry only re-attempts
  // what is actually still there.
  it('a mid-batch merge failure self-heals the gate instead of trapping it, and a retry completes (FIX 1)', async () => {
    const poolId = deriveLocationId(CAMP_ID, 'Pool')
    const poolUpperId = deriveLocationId(CAMP_ID, 'POOL')
    const poolLowerId = deriveLocationId(CAMP_ID, 'pool')

    let poolUpperMerged = false
    let poolLowerAttempts = 0

    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') {
        const rows = [location({ id: poolId, name: 'Pool', capacity: 3 })]
        if (!poolUpperMerged) rows.push(location({ id: poolUpperId, name: 'POOL', capacity: 1 }))
        rows.push(location({ id: poolLowerId, name: 'pool', capacity: 1 }))
        return Promise.resolve(rows)
      }
      if (entity === 'activities') {
        return Promise.resolve([
          activity({ id: 'act-1', location_id: poolId }),
          activity({ id: 'act-2', location_id: poolId }),
          activity({ id: 'act-3', location_id: poolUpperId }),
          activity({ id: 'act-4', location_id: poolLowerId }),
        ])
      }
      return Promise.resolve([])
    })
    localClient.listMigrationReviews.mockResolvedValue([
      review({ id: 'r-Pool', location_id: poolId, name: 'Pool', kind: 'near_duplicate', detail: { variants: ['POOL', 'Pool', 'pool'] } }),
      review({ id: 'r-POOL', location_id: poolUpperId, name: 'POOL', kind: 'near_duplicate', detail: { variants: ['POOL', 'Pool', 'pool'] } }),
      review({ id: 'r-pool', location_id: poolLowerId, name: 'pool', kind: 'near_duplicate', detail: { variants: ['POOL', 'Pool', 'pool'] } }),
    ])
    // Real deleteOrMergeLocation behavior, keyed by loser: the first loser
    // (POOL) succeeds outright; the second (pool) fails once with a genuine
    // transient error (a concurrent bind), then succeeds on retry.
    localClient.mergeLocation.mockImplementation(({ loser_id }) => {
      if (loser_id === poolUpperId) {
        poolUpperMerged = true
        return Promise.resolve({ ok: true, cleared: 1, reassigned_activity_ids: ['act-3'] })
      }
      if (loser_id === poolLowerId) {
        poolLowerAttempts += 1
        if (poolLowerAttempts === 1) return Promise.resolve({ error: 'count-changed', ref_count: 1 })
        return Promise.resolve({ ok: true, cleared: 1, reassigned_activity_ids: ['act-4'] })
      }
      return Promise.resolve({ error: 'unexpected-loser' })
    })

    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('These look like the same location')).not.toBeNull())

    fireEvent.click(screen.getByText('Merge into one location'))

    await waitFor(() => expect(localClient.mergeLocation).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText(/That merge could not be completed/)).not.toBeNull())

    // (a) self-heal: the screen refreshed (locations re-listed) after the
    // failure, and the gate no longer offers the already-merged loser.
    await waitFor(() =>
      expect(localClient.list.mock.calls.filter((c) => c[0] === 'locations').length).toBeGreaterThan(1)
    )
    expect(screen.queryByText('POOL')).toBeNull()
    expect(screen.getAllByText('pool').length).toBeGreaterThan(0)

    // (c) "these are different locations" is not the only escape — the Merge
    // button is still present and functional.
    expect(screen.queryByText('Merge into one location')).not.toBeNull()

    // (b) retry: the previously-failed loser now succeeds, completing the
    // merge — it does not die re-hitting the already-deleted first loser.
    fireEvent.click(screen.getByText('Merge into one location'))

    await waitFor(() => expect(localClient.mergeLocation).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(localClient.dismissMigrationReviews).toHaveBeenCalledWith(['r-Pool', 'r-POOL', 'r-pool']))
    expect(screen.queryByText(/That merge could not be completed/)).toBeNull()
  })

  // FIX 1, bullet 2: the sequential loop must tolerate a loser that is
  // already gone (mergeLocation returns 'no-record') by treating it as
  // already-done and continuing to the next loser — not throwing and
  // abandoning a loser that could still merge. This can happen even with
  // fresh state if a peer merged the loser between this device's preview and
  // its confirm.
  it('tolerates an already-merged loser (no-record) mid-batch and continues to complete the merge (FIX 1)', async () => {
    const poolId = deriveLocationId(CAMP_ID, 'Pool')
    const poolUpperId = deriveLocationId(CAMP_ID, 'POOL')
    const poolLowerId = deriveLocationId(CAMP_ID, 'pool')

    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') {
        return Promise.resolve([
          location({ id: poolId, name: 'Pool', capacity: 3 }),
          location({ id: poolUpperId, name: 'POOL', capacity: 1 }),
          location({ id: poolLowerId, name: 'pool', capacity: 1 }),
        ])
      }
      if (entity === 'activities') {
        return Promise.resolve([
          activity({ id: 'act-1', location_id: poolId }),
          activity({ id: 'act-2', location_id: poolId }),
        ])
      }
      return Promise.resolve([])
    })
    localClient.listMigrationReviews.mockResolvedValue([
      review({ id: 'r-Pool', location_id: poolId, name: 'Pool', kind: 'near_duplicate', detail: { variants: ['POOL', 'Pool', 'pool'] } }),
      review({ id: 'r-POOL', location_id: poolUpperId, name: 'POOL', kind: 'near_duplicate', detail: { variants: ['POOL', 'Pool', 'pool'] } }),
      review({ id: 'r-pool', location_id: poolLowerId, name: 'pool', kind: 'near_duplicate', detail: { variants: ['POOL', 'Pool', 'pool'] } }),
    ])
    // POOL was already merged away by another device between this device's
    // load and its confirm — the host genuinely reports 'no-record' for it.
    // pool is still there and merges normally.
    localClient.mergeLocation.mockImplementation(({ loser_id }) => {
      if (loser_id === poolUpperId) return Promise.resolve({ error: 'no-record' })
      if (loser_id === poolLowerId) return Promise.resolve({ ok: true, cleared: 0, reassigned_activity_ids: [] })
      return Promise.resolve({ error: 'unexpected-loser' })
    })

    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('These look like the same location')).not.toBeNull())

    fireEvent.click(screen.getByText('Merge into one location'))

    await waitFor(() => expect(localClient.mergeLocation).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(localClient.dismissMigrationReviews).toHaveBeenCalledWith(['r-Pool', 'r-POOL', 'r-pool']))
    expect(screen.queryByText(/That merge could not be completed/)).toBeNull()
  })
})

// M5 — per-week location availability, mirroring ActivitiesScreen/GroupsScreen's
// week-exclusion toggle exactly: a WeekToggle column when weekId is present,
// toggle-off writes week_id then location_id, toggle-on deletes the row, and
// closing a location with placed slots requires confirmation first.
describe('LocationsScreen — week availability (M5)', () => {
  const WEEK_ID = 'week-1'
  const weeks = [{ id: WEEK_ID, camp_id: CAMP_ID, name: 'Week 1', sort_order: 0, is_archived: 0 }]

  it('shows a week column with a WeekToggle per location when weekId is set', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location({ id: 'loc-1', name: 'Pool' })])
      return Promise.resolve([])
    })

    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={WEEK_ID} weeks={weeks} onSelectWeek={() => {}} />)

    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())
    expect(screen.getByRole('switch')).toBeTruthy()
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true')
  })

  it('closing a location with no placed slots writes the exclusion immediately, no confirm', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location({ id: 'loc-1', name: 'Pool' })])
      return Promise.resolve([])
    })

    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={WEEK_ID} weeks={weeks} onSelectWeek={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByRole('switch'))

    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    expect(localClient.write.mock.calls[0][1]).toBe('week_location_exclusions')
    expect(localClient.write.mock.calls[0][3]).toBe('week_id')
    expect(localClient.write.mock.calls[0][4]).toBe(WEEK_ID)
    expect(localClient.write.mock.calls[1][3]).toBe('location_id')
    expect(localClient.write.mock.calls[1][4]).toBe('loc-1')
    expect(screen.queryByText(/Turn off/)).toBeNull()
  })

  it('closing a location with placed slots shows a confirm dialog with the slot count first', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location({ id: 'loc-1', name: 'Pool' })])
      if (entity === 'activities') return Promise.resolve([activity({ id: 'act-1', location_id: 'loc-1' })])
      if (entity === 'schedule_templates') return Promise.resolve([{ id: 'tmpl-1', week_id: WEEK_ID, kind: 'generated' }])
      if (entity === 'template_slots') return Promise.resolve([
        { id: 's1', template_id: 'tmpl-1', activity_id: 'act-1' },
        { id: 's2', template_id: 'tmpl-1', activity_id: 'act-1' },
      ])
      return Promise.resolve([])
    })

    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={WEEK_ID} weeks={weeks} onSelectWeek={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    fireEvent.click(screen.getByRole('switch'))

    await waitFor(() => expect(screen.queryByText(/Turn off "Pool"/)).not.toBeNull())
    expect(localClient.write).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('Turn off anyway'))
    await waitFor(() => expect(localClient.write).toHaveBeenCalled())
    expect(localClient.write.mock.calls[1][3]).toBe('location_id')
    expect(localClient.write.mock.calls[1][4]).toBe('loc-1')
  })

  it('reopening an excluded location deletes the exclusion row, no confirm', async () => {
    const exclusionRow = { id: 'excl-1', week_id: WEEK_ID, location_id: 'loc-1' }
    localClient.list.mockImplementation((entity) => {
      if (entity === 'locations') return Promise.resolve([location({ id: 'loc-1', name: 'Pool' })])
      if (entity === 'week_location_exclusions') return Promise.resolve([exclusionRow])
      return Promise.resolve([])
    })
    localClient.listByScope.mockImplementation((entity, scopeId) => {
      if (entity === 'week_location_exclusions' && scopeId === WEEK_ID) return Promise.resolve([exclusionRow])
      return Promise.resolve([])
    })

    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} weekId={WEEK_ID} weeks={weeks} onSelectWeek={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())
    await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false'))

    fireEvent.click(screen.getByRole('switch'))

    await waitFor(() => expect(localClient.deleteEntity).toHaveBeenCalledWith('token-abc', 'week_location_exclusions', 'excl-1'))
  })
})
