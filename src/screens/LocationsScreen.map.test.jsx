// @vitest-environment jsdom
//
// M6 — the optional camp map (List | Map toggle, upload/replace/remove,
// populated canvas + unplaced tray). docs/adr/2026-08-16-locations-optional-map.md,
// docs/work/specs/2026-08-16-m6-map-design.md. Scoped to rendering/wiring —
// the drag/resize PHYSICS are covered by mapDragFSM.test.js, mapGeometry.test.js,
// useMapDragFSM.test.js, and useLocationGeometryMutations.test.js; jsdom has
// no real pointer capture or layout, so a full drag gesture is not
// meaningfully simulatable here.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

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
  },
}))

vi.mock('./locations/mapImageProcessing', async () => {
  const actual = await vi.importActual('./locations/mapImageProcessing')
  return {
    ...actual,
    processMapImage: vi.fn(),
  }
})

import LocationsScreen from './LocationsScreen'
import { localClient } from '../localClient'
import { processMapImage, MapImageError } from './locations/mapImageProcessing'

const CAMP_ID = 'camp-1'

function location(overrides = {}) {
  return {
    id: 'loc-1', camp_id: CAMP_ID, name: 'Pool', capacity: 1, notes: null, sort_order: 1,
    map_geometry: null,
    ...overrides,
  }
}

function campMapRow(overrides = {}) {
  return {
    id: CAMP_ID, camp_id: CAMP_ID, image_data: 'stub-base64', image_mime: 'image/jpeg',
    image_width: 800, image_height: 600,
    ...overrides,
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => 'token-abc',
    setItem: () => {},
    removeItem: () => {},
  })
  vi.stubGlobal('crypto', { randomUUID: () => 'gesture-id' })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  localClient.list.mockReset().mockImplementation((entity) => {
    if (entity === 'locations') return Promise.resolve([])
    if (entity === 'camp_maps') return Promise.resolve([])
    return Promise.resolve([])
  })
  localClient.listByScope.mockReset().mockResolvedValue([])
  localClient.write.mockReset().mockResolvedValue({ status: 'applied' })
  localClient.previewDelete.mockReset().mockResolvedValue({ ok: true, entity: 'locations', entity_id: 'loc-1', name: 'Pool', ref_count: 0, activities: [] })
  localClient.deleteRecord.mockReset().mockResolvedValue({ ok: true, cleared: 0 })
  localClient.mergeLocation.mockReset().mockResolvedValue({ ok: true, cleared: 0, reassigned_activity_ids: [] })
  localClient.listMigrationReviews.mockReset().mockResolvedValue([])
  localClient.dismissMigrationReviews.mockReset().mockResolvedValue({ ok: true, dismissed: 0 })
  processMapImage.mockReset()
})

describe('LocationsScreen — List | Map toggle', () => {
  it('defaults to the List tab and switches to Map on click', async () => {
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('No locations yet')).not.toBeNull())
    expect(screen.queryByText('No map yet')).toBeNull()

    fireEvent.click(screen.getByText('Map'))
    await waitFor(() => expect(screen.queryByText('No map yet')).not.toBeNull())
    expect(screen.queryByText('No locations yet')).toBeNull()
  })
})

describe('LocationsScreen — Map tab empty state', () => {
  it('admin sees the upload CTA', async () => {
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    fireEvent.click(await screen.findByText('Map'))
    await waitFor(() => expect(screen.queryByText('No map yet')).not.toBeNull())
    expect(screen.queryByText('Upload a map image')).not.toBeNull()
  })

  it('staff sees no CTA at all (not a disabled one — "no coming-soon controls")', async () => {
    render(<LocationsScreen campId={CAMP_ID} role="staff" onNavigate={() => {}} />)
    fireEvent.click(await screen.findByText('Map'))
    await waitFor(() => expect(screen.queryByText('No map yet')).not.toBeNull())
    expect(screen.queryByText('Upload a map image')).toBeNull()
    expect(screen.queryByText(/Your director hasn't added a camp map yet/)).not.toBeNull()
  })
})

describe('LocationsScreen — Map upload flow', () => {
  it('a successful upload calls processMapImage and writes all four camp_maps fields, then reloads the populated view', async () => {
    processMapImage.mockResolvedValue({ base64: 'abc123', mime: 'image/jpeg', width: 800, height: 600 })
    let mapRow = null
    localClient.list.mockImplementation((entity) => {
      if (entity === 'camp_maps') return Promise.resolve(mapRow ? [mapRow] : [])
      if (entity === 'locations') return Promise.resolve([])
      return Promise.resolve([])
    })
    localClient.write.mockImplementation((token, entity, id, field, value) => {
      if (entity === 'camp_maps') {
        mapRow = mapRow || { id, camp_id: id }
        mapRow[field] = value
      }
      return Promise.resolve({ status: 'applied' })
    })

    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    fireEvent.click(await screen.findByText('Map'))
    await waitFor(() => expect(screen.queryByText('Upload a map image')).not.toBeNull())

    const file = new File(['x'], 'map.jpg', { type: 'image/jpeg' })
    const input = document.querySelector('input[type="file"]')
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() => expect(processMapImage).toHaveBeenCalledWith(file))
    await waitFor(() => {
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'camp_maps', CAMP_ID, 'image_data', 'abc123')
    })
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'camp_maps', CAMP_ID, 'image_mime', 'image/jpeg')
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'camp_maps', CAMP_ID, 'image_width', 800)
    expect(localClient.write).toHaveBeenCalledWith('token-abc', 'camp_maps', CAMP_ID, 'image_height', 600)

    // Reloads to the populated canvas — the empty-state CTA is gone.
    await waitFor(() => expect(screen.queryByText('Upload a map image')).toBeNull())
  })

  it('a rejected upload (bad type) shows the director-facing error and leaves the empty state untouched', async () => {
    processMapImage.mockRejectedValue(new MapImageError('bad_type', "That file isn't a photo Shoresh can use. Choose a JPG, PNG, or WEBP image."))
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    fireEvent.click(await screen.findByText('Map'))
    await waitFor(() => expect(screen.queryByText('Upload a map image')).not.toBeNull())

    const file = new File(['x'], 'evil.svg', { type: 'image/svg+xml' })
    const input = document.querySelector('input[type="file"]')
    fireEvent.change(input, { target: { files: [file] } })

    await waitFor(() =>
      expect(screen.queryByText("That file isn't a photo Shoresh can use. Choose a JPG, PNG, or WEBP image.")).not.toBeNull()
    )
    // A failed upload never clears/writes anything.
    expect(localClient.write).not.toHaveBeenCalled()
  })
})

describe('LocationsScreen — Map populated view', () => {
  it('renders placed locations on the canvas and unplaced ones in the tray', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'camp_maps') return Promise.resolve([campMapRow()])
      if (entity === 'locations') {
        return Promise.resolve([
          location({ id: 'loc-placed', name: 'Pool', map_geometry: JSON.stringify({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }) }),
          location({ id: 'loc-unplaced', name: 'Gym', map_geometry: null }),
        ])
      }
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    fireEvent.click(await screen.findByText('Map'))

    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())
    expect(screen.queryByText('Gym')).not.toBeNull()
    expect(screen.queryByText('Not yet placed')).not.toBeNull()
    expect(screen.queryByText('(1)')).not.toBeNull()
  })

  it('the unplaced tray is entirely absent when every location is placed (absent, not empty)', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'camp_maps') return Promise.resolve([campMapRow()])
      if (entity === 'locations') {
        return Promise.resolve([location({ id: 'loc-placed', name: 'Pool', map_geometry: JSON.stringify({ x: 0, y: 0, w: 0.1, h: 0.1 }) })])
      }
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    fireEvent.click(await screen.findByText('Map'))
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())
    expect(screen.queryByText('Not yet placed')).toBeNull()
  })

  it('staff sees no admin toolbar (Replace/Remove) on a populated map', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'camp_maps') return Promise.resolve([campMapRow()])
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="staff" onNavigate={() => {}} />)
    fireEvent.click(await screen.findByText('Map'))
    await waitFor(() => expect(document.querySelector('.map-canvas')).not.toBeNull())
    expect(screen.queryByText('Replace image')).toBeNull()
    expect(screen.queryByText('Remove image')).toBeNull()
  })
})

describe('LocationsScreen — Remove map image', () => {
  it('shows a real confirmation and, on confirm, writes image_data: null and reverts to the empty state', async () => {
    let mapRow = campMapRow()
    localClient.list.mockImplementation((entity) => {
      if (entity === 'camp_maps') return Promise.resolve(mapRow ? [mapRow] : [])
      return Promise.resolve([])
    })
    localClient.write.mockImplementation((token, entity, id, field, value) => {
      if (entity === 'camp_maps' && field === 'image_data' && value === null) {
        mapRow = { ...mapRow, image_data: null }
      }
      return Promise.resolve({ status: 'applied' })
    })

    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    fireEvent.click(await screen.findByText('Map'))
    await waitFor(() => expect(screen.queryByText('Remove image')).not.toBeNull())

    fireEvent.click(screen.getByText('Remove image'))
    expect(screen.queryByText('Remove the map image?')).not.toBeNull()
    expect(screen.queryByText(/can't be undone from Trash/)).not.toBeNull()

    fireEvent.click(screen.getByText('Remove Map Image'))

    await waitFor(() =>
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'camp_maps', CAMP_ID, 'image_data', null)
    )
    await waitFor(() => expect(screen.queryByText('No map yet')).not.toBeNull())
  })
})

// Tester MEDIUM (M6 fix round): Designer spec §4 — a selected place's wash
// steps 10% -> 16% (border weight unchanged). jsdom under this repo's vitest
// config does not apply external stylesheets (no `css: true`), so the actual
// color-mix output can't be read back via getComputedStyle here — instead
// this asserts the two halves of the wiring that TOGETHER produce that
// effect: the inline background is CSS-var-driven (not a bare literal, so a
// stylesheet rule CAN step it), and locationMap.css's [data-selected] rule
// sets that var to 16%. Click-to-select setting the attribute itself is
// already pinned by useMapDragFSM.test.js's "selectLocation marks the
// location data-selected" case; this test also exercises it through the real
// assembled LocationsScreen wiring, not just the isolated hook.
describe('LocationsScreen — Map marker selected wash (Designer spec §4)', () => {
  it('a placed marker\'s wash is CSS-var-driven, and clicking it sets data-selected', async () => {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'camp_maps') return Promise.resolve([campMapRow()])
      if (entity === 'locations') {
        return Promise.resolve([
          location({ id: 'loc-placed', name: 'Pool', map_geometry: JSON.stringify({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }) }),
        ])
      }
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    fireEvent.click(await screen.findByText('Map'))
    await waitFor(() => expect(screen.queryByText('Pool')).not.toBeNull())

    const marker = document.querySelector('.map-location')
    expect(marker).not.toBeNull()
    // At rest: falls through the CSS var's own 10% fallback, not a bare
    // literal — this is what lets a stylesheet rule step it on selection.
    expect(marker.style.background).toContain('var(--marker-wash, 10%)')
    expect(marker.hasAttribute('data-selected')).toBe(false)

    fireEvent.click(marker)
    expect(marker.hasAttribute('data-selected')).toBe(true)
  })

  it('locationMap.css steps --marker-wash to 16% on [data-selected] (border weight stays untouched)', () => {
    const css = fs.readFileSync(path.join(__dirname, '../components/locations/locationMap.css'), 'utf8')
    const match = css.match(/\.map-location\[data-selected\]\s*{([^}]*)}/)
    expect(match, 'expected a .map-location[data-selected] rule in locationMap.css').toBeTruthy()
    expect(match[1]).toMatch(/--marker-wash:\s*16%/)
    expect(match[1]).toMatch(/outline:\s*2px solid var\(--primary\)/)
    expect(match[1]).not.toMatch(/border/)
  })
})

// Create-in-place: click empty canvas -> inline name input -> commit creates
// a location with map_geometry computed the same way a tray drop would.
// jsdom has no real layout, so every test here stubs getBoundingClientRect
// on the canvas element to a fixed pixel box.
describe('LocationsScreen — Map click-to-create', () => {
  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 800, height: 600, left: 0, top: 0, right: 800, bottom: 600, x: 0, y: 0, toJSON() {},
    })
  })

  async function renderPopulatedMap(locationsList = []) {
    localClient.list.mockImplementation((entity) => {
      if (entity === 'camp_maps') return Promise.resolve([campMapRow()])
      if (entity === 'locations') return Promise.resolve(locationsList)
      return Promise.resolve([])
    })
    render(<LocationsScreen campId={CAMP_ID} role="admin" onNavigate={() => {}} />)
    fireEvent.click(await screen.findByText('Map'))
    await waitFor(() => expect(document.querySelector('.map-canvas')).not.toBeNull())
  }

  it('clicking empty canvas opens an inline name input at the click point', async () => {
    await renderPopulatedMap()
    const canvas = document.querySelector('.map-canvas')
    fireEvent.click(canvas, { clientX: 400, clientY: 300 })

    const input = document.querySelector('input[placeholder="e.g. Pool, Gym, Beit Midrash"]')
    expect(input).not.toBeNull()
  })

  it('committing a name creates a location with map_geometry matching the tray-drop geometry shape', async () => {
    await renderPopulatedMap()
    const canvas = document.querySelector('.map-canvas')
    fireEvent.click(canvas, { clientX: 400, clientY: 300 })

    const input = document.querySelector('input[placeholder="e.g. Pool, Gym, Beit Midrash"]')
    fireEvent.change(input, { target: { value: 'Field House' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(localClient.write).toHaveBeenCalledWith('token-abc', 'locations', expect.any(String), 'name', 'Field House')
    })
    const geometryCall = localClient.write.mock.calls.find(
      (call) => call[1] === 'locations' && call[3] === 'map_geometry'
    )
    expect(geometryCall).toBeTruthy()
    const geometry = JSON.parse(geometryCall[4])
    // Same shape defaultTrayGeometry produces for a tray drop: fixed w/h,
    // x/y centered on (then clamped around) the drop point.
    expect(geometry).toEqual({ x: 0.44, y: 0.45, w: 0.12, h: 0.1 })
  })

  it('Escape cancels the draft with no write', async () => {
    await renderPopulatedMap()
    const canvas = document.querySelector('.map-canvas')
    fireEvent.click(canvas, { clientX: 400, clientY: 300 })
    const input = document.querySelector('input[placeholder="e.g. Pool, Gym, Beit Midrash"]')
    fireEvent.change(input, { target: { value: 'Field House' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(document.querySelector('input[placeholder="e.g. Pool, Gym, Beit Midrash"]')).toBeNull()
    expect(localClient.write).not.toHaveBeenCalled()
  })

  it('a blank name on Enter cancels with no write', async () => {
    await renderPopulatedMap()
    const canvas = document.querySelector('.map-canvas')
    fireEvent.click(canvas, { clientX: 400, clientY: 300 })
    const input = document.querySelector('input[placeholder="e.g. Pool, Gym, Beit Midrash"]')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(document.querySelector('input[placeholder="e.g. Pool, Gym, Beit Midrash"]')).toBeNull()
    expect(localClient.write).not.toHaveBeenCalled()
  })

  it('a duplicate name surfaces the collision error, not a crash', async () => {
    await renderPopulatedMap()
    localClient.write.mockImplementation((token, entity, id, field) => {
      if (entity === 'locations' && field === 'name') return Promise.resolve({ status: 'rejected', error: 'unique-collision' })
      return Promise.resolve({ status: 'applied' })
    })
    const canvas = document.querySelector('.map-canvas')
    fireEvent.click(canvas, { clientX: 400, clientY: 300 })
    const input = document.querySelector('input[placeholder="e.g. Pool, Gym, Beit Midrash"]')
    fireEvent.change(input, { target: { value: 'Pool' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => expect(screen.queryByText(/That location could not be added/)).not.toBeNull())
    // Draft input stays open so the director can retry a different name.
    expect(document.querySelector('input[placeholder="e.g. Pool, Gym, Beit Midrash"]')).not.toBeNull()
  })

  it('clicking an existing marker does not open the create input', async () => {
    await renderPopulatedMap([
      location({ id: 'loc-placed', name: 'Pool', map_geometry: JSON.stringify({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }) }),
    ])
    const marker = document.querySelector('.map-location')
    expect(marker).not.toBeNull()
    fireEvent.click(marker)

    expect(document.querySelector('input[placeholder="e.g. Pool, Gym, Beit Midrash"]')).toBeNull()
  })
})
