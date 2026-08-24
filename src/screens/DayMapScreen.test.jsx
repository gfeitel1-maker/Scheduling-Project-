// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

vi.mock('../localClient', () => ({
  localClient: {
    list: vi.fn(),
  },
}))

import DayMapScreen from './DayMapScreen'
import { localClient } from '../localClient'

const CAMP_ID = 'camp-1'
const WEEK_ID = 'week-1'

const day = { id: 'day-1', camp_id: CAMP_ID, label: 'Monday', day_of_week: 1, sort_order: 0 }
const block = { id: 'block-1', camp_id: CAMP_ID, name: 'Period 1', start_time: '09:00', end_time: '10:00', sort_order: 0 }
const mapRow = { camp_id: CAMP_ID, image_data: 'ZmFrZQ==', image_mime: 'image/jpeg', image_width: 100, image_height: 100 }

function locationRow(overrides = {}) {
  return { id: 'loc-1', camp_id: CAMP_ID, name: 'Pool', capacity: 1, map_geometry: JSON.stringify({ x: 0.2, y: 0.3, w: 0.1, h: 0.1 }), ...overrides }
}

function mockTable({ templates = [], slots = [], activities = [], locations = [], groups = [], days = [day], blocks = [block], maps = [mapRow] } = {}) {
  localClient.list.mockImplementation((entity) => {
    switch (entity) {
      case 'schedule_templates': return Promise.resolve(templates)
      case 'template_slots': return Promise.resolve(slots)
      case 'activities': return Promise.resolve(activities)
      case 'locations': return Promise.resolve(locations)
      case 'groups': return Promise.resolve(groups)
      case 'days_of_operation': return Promise.resolve(days)
      case 'time_blocks': return Promise.resolve(blocks)
      case 'camp_maps': return Promise.resolve(maps)
      default: return Promise.resolve([])
    }
  })
}

beforeEach(() => {
  localClient.list.mockReset()
})

describe('DayMapScreen', () => {
  it('shows an empty state with a CTA when no camp map is uploaded', async () => {
    mockTable({ maps: [] })
    render(<DayMapScreen campId={CAMP_ID} weekId={WEEK_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('No map yet')).not.toBeNull())
    expect(screen.queryByText('Upload a map')).not.toBeNull()
  })

  it('shows an empty state pointing to the route screen when no schedule is built', async () => {
    mockTable({ templates: [] })
    render(<DayMapScreen campId={CAMP_ID} weekId={WEEK_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText(/No generated schedule built yet/)).not.toBeNull())
  })

  it('renders a marker for a group at a located activity', async () => {
    mockTable({
      templates: [{ id: 'tpl-1', week_id: WEEK_ID, kind: 'generated' }],
      slots: [{ template_id: 'tpl-1', day_id: 'day-1', time_block_id: 'block-1', activity_id: 'act-1', group_id: 'grp-1' }],
      activities: [{ id: 'act-1', camp_id: CAMP_ID, name: 'Swim', location_id: 'loc-1' }],
      locations: [locationRow()],
      groups: [{ id: 'grp-1', camp_id: CAMP_ID, name: 'Bears' }],
    })
    render(<DayMapScreen campId={CAMP_ID} weekId={WEEK_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Bears')).not.toBeNull())
    expect(screen.queryByText('Pool')).not.toBeNull()
  })

  it('shows the jam badge when occupants exceed capacity', async () => {
    mockTable({
      templates: [{ id: 'tpl-1', week_id: WEEK_ID, kind: 'generated' }],
      slots: [
        { template_id: 'tpl-1', day_id: 'day-1', time_block_id: 'block-1', activity_id: 'act-1', group_id: 'grp-1' },
        { template_id: 'tpl-1', day_id: 'day-1', time_block_id: 'block-1', activity_id: 'act-1', group_id: 'grp-2' },
      ],
      activities: [{ id: 'act-1', camp_id: CAMP_ID, name: 'Swim', location_id: 'loc-1' }],
      locations: [locationRow({ capacity: 1 })],
      groups: [
        { id: 'grp-1', camp_id: CAMP_ID, name: 'Bears' },
        { id: 'grp-2', camp_id: CAMP_ID, name: 'Foxes' },
      ],
    })
    render(<DayMapScreen campId={CAMP_ID} weekId={WEEK_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('2/1')).not.toBeNull())
  })

  it('lists a group whose activity has no location in the Not on the map panel', async () => {
    mockTable({
      templates: [{ id: 'tpl-1', week_id: WEEK_ID, kind: 'generated' }],
      slots: [{ template_id: 'tpl-1', day_id: 'day-1', time_block_id: 'block-1', activity_id: 'act-2', group_id: 'grp-1' }],
      activities: [{ id: 'act-2', camp_id: CAMP_ID, name: 'Art', location_id: null }],
      locations: [],
      groups: [{ id: 'grp-1', camp_id: CAMP_ID, name: 'Bears' }],
    })
    render(<DayMapScreen campId={CAMP_ID} weekId={WEEK_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Not on the map')).not.toBeNull())
    expect(screen.queryByText('Bears')).not.toBeNull()
  })

  it('surfaces a group at a LOCATED-but-unpositioned location (map_geometry null) instead of dropping it (Red Hat HIGH)', async () => {
    mockTable({
      templates: [{ id: 'tpl-1', week_id: WEEK_ID, kind: 'generated' }],
      slots: [{ template_id: 'tpl-1', day_id: 'day-1', time_block_id: 'block-1', activity_id: 'act-1', group_id: 'grp-1' }],
      activities: [{ id: 'act-1', camp_id: CAMP_ID, name: 'Swim', location_id: 'loc-1' }],
      locations: [locationRow({ map_geometry: null })], // located, never placed on the map
      groups: [{ id: 'grp-1', camp_id: CAMP_ID, name: 'Bears' }],
    })
    render(<DayMapScreen campId={CAMP_ID} weekId={WEEK_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Not on the map')).not.toBeNull())
    // The location name + its group appear in the off-map panel — NOT vanished.
    expect(screen.queryByText('Pool')).not.toBeNull()
    expect(screen.queryByText(/Bears — not placed on the map yet/)).not.toBeNull()
  })

  it('shows the jam even when the jammed location is unpositioned — a hidden jam must not read as calm (Red Hat HIGH)', async () => {
    mockTable({
      templates: [{ id: 'tpl-1', week_id: WEEK_ID, kind: 'generated' }],
      slots: [
        { template_id: 'tpl-1', day_id: 'day-1', time_block_id: 'block-1', activity_id: 'act-1', group_id: 'grp-1' },
        { template_id: 'tpl-1', day_id: 'day-1', time_block_id: 'block-1', activity_id: 'act-1', group_id: 'grp-2' },
      ],
      activities: [{ id: 'act-1', camp_id: CAMP_ID, name: 'Swim', location_id: 'loc-1' }],
      locations: [locationRow({ capacity: 1, map_geometry: null })],
      groups: [{ id: 'grp-1', camp_id: CAMP_ID, name: 'Bears' }, { id: 'grp-2', camp_id: CAMP_ID, name: 'Foxes' }],
    })
    render(<DayMapScreen campId={CAMP_ID} weekId={WEEK_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('2/1')).not.toBeNull())
  })

  it('does not crash on malformed map_geometry — routes the location off-map (Red Hat)', async () => {
    mockTable({
      templates: [{ id: 'tpl-1', week_id: WEEK_ID, kind: 'generated' }],
      slots: [{ template_id: 'tpl-1', day_id: 'day-1', time_block_id: 'block-1', activity_id: 'act-1', group_id: 'grp-1' }],
      activities: [{ id: 'act-1', camp_id: CAMP_ID, name: 'Swim', location_id: 'loc-1' }],
      locations: [locationRow({ map_geometry: '{not valid json' })],
      groups: [{ id: 'grp-1', camp_id: CAMP_ID, name: 'Bears' }],
    })
    render(<DayMapScreen campId={CAMP_ID} weekId={WEEK_ID} onNavigate={() => {}} />)
    await waitFor(() => expect(screen.queryByText('Not on the map')).not.toBeNull())
    expect(screen.queryByText('Pool')).not.toBeNull()
  })
})
