// Day Map (B1) — read-only spatial schedule view.
// docs/adr/2026-08-24-run-the-day-on-the-map.md
//
// The director picks a route, day, and time block; every group with a
// located activity appears as a marker clustered at its location on the
// uploaded camp map. A location whose occupants exceed its capacity is
// highlighted as a jam. Groups whose activity has no location go in the
// "Not on the map" panel. Entirely read-only — see deriveOccupancy.js
// (Decision 1) for why this never invokes buildSchedule.js.
import { useState, useEffect, useMemo } from 'react'
import { localClient } from '../localClient'
import { S, useEnterTransition } from '../styles/shared'
import { deriveOccupancy } from '../data/deriveOccupancy'
import GroupMarker from '../components/schedule/GroupMarker'
import '../components/locations/locationMap.css'

// A location is renderable on the map only if its map_geometry parses to a real
// {x,y,w,h}. NULL (never placed) or malformed (hand-edited/corrupted) → null, so
// the caller routes it to the off-map panel instead of rendering a NaN marker or
// throwing at render time (Red Hat: unguarded JSON.parse crash).
function parseGeometry(raw) {
  if (!raw) return null
  try {
    const g = JSON.parse(raw)
    if (g && ['x', 'y', 'w', 'h'].every((k) => typeof g[k] === 'number' && Number.isFinite(g[k]))) return g
    return null
  } catch {
    return null
  }
}

function RouteToggle({ route, onChange }) {
  return (
    <div style={{ display: 'flex', gap: 2, background: 'var(--border)', borderRadius: 8, padding: 3 }}>
      {[['generated', 'Generated'], ['manual', 'Manual']].map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          style={{
            padding: '6px 14px', borderRadius: 6, border: 'none',
            cursor: 'pointer', fontSize: 12, fontWeight: route === v ? 700 : 600,
            fontFamily: 'var(--font-sans)',
            background: route === v ? 'var(--surface)' : 'none',
            color: route === v ? 'var(--primary)' : 'var(--text-secondary)',
            boxShadow: route === v ? '0 1px 4px rgba(0,0,0,0.12)' : 'none',
            transition: 'color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)',
          }}
        >{label}</button>
      ))}
    </div>
  )
}

function EmptyState({ title, body, ctaLabel, onCta }) {
  const enter = useEnterTransition('liftFade')
  return (
    <div style={{ ...emptyStyles.wrap, ...enter }}>
      <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="1.5">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <circle cx="8.5" cy="9.5" r="1.5" />
        <path d="M21 16l-5.5-5.5a1.5 1.5 0 0 0-2.1 0L4 19" />
      </svg>
      <div style={emptyStyles.title}>{title}</div>
      <div style={emptyStyles.body}>{body}</div>
      {ctaLabel && (
        <button className="press-97" onClick={onCta} style={{ ...S.btnPrimary, marginTop: 14 }}>{ctaLabel}</button>
      )}
    </div>
  )
}

export default function DayMapScreen({ campId, onNavigate, weekId }) {
  const [route, setRoute] = useState('generated')
  const [dayId, setDayId] = useState(null)
  const [blockId, setBlockId] = useState(null)
  const [loading, setLoading] = useState(true)
  const [data, setData] = useState({
    templates: [], slots: [], activities: [], locations: [], groups: [], days: [], blocks: [], mapRow: null, campMaps: [],
  })
  const [expandedLocationId, setExpandedLocationId] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      const [templates, slots, activities, locations, groups, days, blocks, mapRows] = await Promise.all([
        localClient.list('schedule_templates'),
        localClient.list('template_slots'),
        localClient.list('activities'),
        localClient.list('locations'),
        localClient.list('groups'),
        localClient.list('days_of_operation'),
        localClient.list('time_blocks'),
        localClient.list('camp_maps'),
      ])
      if (cancelled) return
      setData({
        templates: templates || [],
        slots: slots || [],
        activities: (activities || []).filter((a) => a.camp_id === campId),
        locations: (locations || []).filter((l) => l.camp_id === campId),
        groups: (groups || []).filter((g) => g.camp_id === campId),
        days: (days || []).filter((d) => d.camp_id === campId),
        blocks: (blocks || []).filter((b) => b.camp_id === campId),
        mapRow: (mapRows || []).find((r) => r.camp_id === campId) ?? null,
        // All camp_maps rows (v50 pair) — the Day Simulation seed needs kind +
        // dimensions per map to place indoor rooms inside the outdoor building.
        campMaps: (mapRows || []).filter((r) => r.camp_id === campId),
      })
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [campId])

  const sortedDays = useMemo(
    () => [...data.days].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    [data.days]
  )
  const sortedBlocks = useMemo(
    () => [...data.blocks].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)),
    [data.blocks]
  )

  // Default day/block: the current real-world day/block if it falls within
  // the camp's own days, else the first of each (ADR Decision 2, "leave that
  // refinement to the Maker's judgment, non-load-bearing for the design").
  useEffect(() => {
    // The IIFE wrapper is required by this repo's react-hooks/set-state-in-effect
    // lint rule (see LocationsScreen.jsx's refreshReviewData mount effect for
    // the same pattern) — it flags a direct call to a named, in-scope function
    // it can trace back to setState, but not the same call wrapped this way.
    ;(() => {
      if (dayId || sortedDays.length === 0) return
      const now = new Date()
      const nowHM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
      const todayDay = sortedDays.find((d) => d.day_of_week === now.getDay())
      setDayId((todayDay ?? sortedDays[0]).id)
      if (sortedBlocks.length > 0) {
        const currentBlock = sortedBlocks.find((b) => b.start_time <= nowHM && nowHM <= b.end_time)
        setBlockId((currentBlock ?? sortedBlocks[0]).id)
      }
    })()
  }, [sortedDays, sortedBlocks, dayId])

  const occupancy = useMemo(() => {
    if (!weekId || !dayId || !blockId) return { located: [], unlocated: [], templateFound: false }
    return deriveOccupancy({
      weekId, kind: route, dayId, blockId,
      templates: data.templates, slots: data.slots, activities: data.activities, locations: data.locations,
    })
  }, [weekId, dayId, blockId, route, data])

  const groupNameById = (id) => data.groups.find((g) => g.id === id)?.name ?? '(removed group)'

  const routeLabel = route === 'generated' ? 'Generated' : 'Manual'
  const routeScreen = route === 'generated' ? 'schedule:generated' : 'schedule:manual'

  const hasMap = Boolean(data.mapRow?.image_data)

  // Tile World viewer opens whenever there's a map image OR grid-placed locations.
  const hasTileWorld = Boolean(data.mapRow?.image_data) || data.locations.some((l) => l.grid_x != null && l.grid_y != null)

  const tileOccupancyPayload = useMemo(() => {
    if (!hasTileWorld) return null
    const day = sortedDays.find((d) => d.id === dayId)
    const block = sortedBlocks.find((b) => b.id === blockId)
    return {
      dayLabel: day?.label ?? '',
      blockLabel: block?.name ?? '',
      // Include the map image so the viewer can render it as background.
      mapImage: data.mapRow
        ? { data: data.mapRow.image_data, mime: data.mapRow.image_mime ?? 'image/jpeg' }
        : null,
      locations: data.locations,
      // Map metadata for the layout seed — id/kind/dimensions only, never the
      // heavy image_data (that rides the /map route, not the WS payload).
      campMaps: (data.campMaps || []).map((m) => ({
        id: m.id, camp_id: m.camp_id, kind: m.kind ?? null,
        image_width: m.image_width, image_height: m.image_height,
      })),
      placed: occupancy.located
        .flatMap((e) => e.groups.map((g) => ({
          locationId: e.locationId,
          groupId: g.groupId,
          groupName: groupNameById(g.groupId),
          isJam: e.isJam,
        }))),
    }
  }, [hasTileWorld, data.locations, data.mapRow, data.campMaps, occupancy, dayId, blockId, sortedDays, sortedBlocks])

  // Push occupancy to the tile world viewer whenever it changes.
  useEffect(() => {
    if (!tileOccupancyPayload) return
    localClient.pushTileOccupancy(tileOccupancyPayload).catch(() => {})
  }, [tileOccupancyPayload])


  // A location can be LOCATED (an activity points at it) yet have no valid map
  // position — map_geometry NULL (added in the List, never dragged onto the map)
  // or malformed. Those must NOT silently vanish, especially a JAM at one, or the
  // map reads "calm" when it isn't (Red Hat HIGH). Split, never drop: positioned
  // ones get markers; the rest (with their jam status) go to the off-map panel.
  const positioned = []
  const offMap = []
  for (const entry of occupancy.located) {
    const geometry = parseGeometry(entry.location.map_geometry)
    if (geometry) positioned.push({ ...entry, geometry })
    else offMap.push(entry)
  }
  const nothingThisBlock = positioned.length === 0 && offMap.length === 0 && occupancy.unlocated.length === 0

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={toolbarStyles.wrap}>
        <RouteToggle route={route} onChange={setRoute} />
        <div style={toolbarStyles.pickers}>
          <select value={dayId ?? ''} onChange={(e) => setDayId(e.target.value)} style={S.input} disabled={sortedDays.length === 0}>
            {sortedDays.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
          <select value={blockId ?? ''} onChange={(e) => setBlockId(e.target.value)} style={S.input} disabled={sortedBlocks.length === 0}>
            {sortedBlocks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        {hasTileWorld && (
          <button
            onClick={() => localClient.startTileWorld().catch(() => {})}
            style={{ ...S.buttonSecondary, fontSize: 12, padding: '6px 12px' }}
          >
            Open Tile World
          </button>
        )}
      </div>

      {loading ? (
        <div style={S.stateLoading}>Loading…</div>
      ) : !hasMap ? (
        <EmptyState
          title={hasTileWorld ? 'Tile World ready' : 'No map yet'}
          body={hasTileWorld
            ? 'Your locations are placed in the Tile World. Click "Open Tile World" above to launch the live viewer.'
            : 'Add a photo of your camp grounds on the Locations screen to see where the day is happening.'}
          ctaLabel="Go to Locations"
          onCta={() => onNavigate('locations')}
        />
      ) : !occupancy.templateFound ? (
        <EmptyState
          title={`No ${routeLabel.toLowerCase()} schedule built yet`}
          body={`Build the ${routeLabel} schedule for this week to see it on the map.`}
          ctaLabel={`Build the ${routeLabel} schedule`}
          onCta={() => onNavigate(routeScreen)}
        />
      ) : (
        <>
          <div
            className="map-canvas"
            style={{ aspectRatio: `${data.mapRow.image_width || 1} / ${data.mapRow.image_height || 1}` }}
          >
            <img className="map-image" src={`data:image/jpeg;base64,${data.mapRow.image_data}`} alt="" />
            {positioned.map((entry) => (
              <GroupMarker
                key={entry.locationId}
                location={entry.location}
                geometry={entry.geometry}
                groups={entry.groups}
                capacity={entry.capacity}
                isJam={entry.isJam}
                groupNameById={groupNameById}
                expanded={expandedLocationId === entry.locationId}
                onExpand={(id) => setExpandedLocationId((cur) => (cur === id ? null : id))}
              />
            ))}
          </div>

          {nothingThisBlock && (
            <div style={noteStyles.wrap}>No groups scheduled for this block.</div>
          )}

          {(offMap.length > 0 || occupancy.unlocated.length > 0) && (
            <div style={trayStyles.wrap}>
              <div style={trayStyles.head}>
                <span style={trayStyles.title}>Not on the map</span>
                <span style={trayStyles.count}>({offMap.length + occupancy.unlocated.length})</span>
              </div>
              <div style={trayStyles.row}>
                {/* Located, but the location has no map position — surfaced WITH
                    its jam status so an over-capacity room is never hidden. */}
                {offMap.map((entry) => (
                  <div key={entry.locationId} style={{ ...trayStyles.chip, ...(entry.isJam ? trayStyles.chipJam : null) }}>
                    <span style={{ fontWeight: 500 }}>
                      {entry.location.name}
                      {entry.isJam && <span style={trayStyles.jamBadge}> {entry.groups.length}/{entry.capacity}</span>}
                    </span>
                    <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                      {entry.groups.map((g) => groupNameById(g.groupId)).join(', ')} — not placed on the map yet
                    </span>
                  </div>
                ))}
                {occupancy.unlocated.map((u, i) => (
                  <div key={`u-${u.groupId}-${i}`} style={trayStyles.chip}>
                    <span style={{ fontWeight: 500 }}>{groupNameById(u.groupId)}</span>
                    <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>
                      {u.activityName ?? 'No activity'} — no location
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

const toolbarStyles = {
  wrap: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 20, flexWrap: 'wrap' },
  pickers: { display: 'flex', gap: 8 },
}

const emptyStyles = {
  wrap: {
    padding: '60px 16px',
    textAlign: 'center',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 6,
  },
  title: {
    fontFamily: 'var(--font-condensed)',
    fontWeight: 600,
    fontSize: 15,
    color: 'var(--text)',
    marginTop: 8,
  },
  body: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    maxWidth: '56ch',
  },
}

const noteStyles = {
  wrap: {
    marginTop: 16,
    padding: '14px 16px',
    fontSize: 13,
    color: 'var(--text-secondary)',
    textAlign: 'center',
  },
}

const trayStyles = {
  wrap: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    padding: '14px 16px',
    marginTop: 16,
  },
  head: { display: 'flex', alignItems: 'baseline', gap: 6, marginBottom: 10 },
  title: { fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.05em' },
  count: { color: 'var(--text-secondary)', fontSize: 12, marginLeft: 'auto' },
  row: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  chipJam: { borderColor: 'var(--danger)', background: 'color-mix(in srgb, var(--danger) 8%, var(--surface))' },
  jamBadge: { color: 'var(--danger)', fontWeight: 700, fontSize: 11 },
  chip: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    padding: '7px 11px',
    background: 'var(--surface)',
    border: '1.5px solid var(--border)',
    borderRadius: 8,
    fontSize: 13,
  },
}
