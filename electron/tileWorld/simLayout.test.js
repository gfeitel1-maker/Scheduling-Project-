// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { deriveSimLayout } from './simLayout.js'

const CAMP = 'camp1'
const W = 1000
const H = 1000
const geo = (x, y, w = 0.1, h = 0.1) => JSON.stringify({ x, y, w, h })

describe('deriveSimLayout — Day Simulation seed (ADR 2026-08-26 D4)', () => {
  it('empty input → empty result', () => {
    expect(deriveSimLayout({ locations: [], campMaps: [], worldWidth: W, worldHeight: H }))
      .toEqual({ placements: {}, unplaced: [] })
  })

  it('a location with no map_geometry goes unplaced (rings)', () => {
    const out = deriveSimLayout({
      locations: [{ id: 'l1', camp_id: CAMP }],
      campMaps: [{ id: CAMP, camp_id: CAMP, kind: null }],
      worldWidth: W, worldHeight: H,
    })
    expect(out.placements).toEqual({})
    expect(out.unplaced).toEqual(['l1'])
  })

  it('single unlabeled map: placements come from real geometry (not a ring), filling the world', () => {
    const out = deriveSimLayout({
      locations: [
        { id: 'l1', camp_id: CAMP, map_id: null, map_geometry: geo(0.2, 0.3) },
        { id: 'l2', camp_id: CAMP, map_id: null, map_geometry: geo(0.8, 0.6) },
      ],
      campMaps: [{ id: CAMP, camp_id: CAMP, kind: null }], // no dimensions → fill
      worldWidth: W, worldHeight: H,
    })
    // center of {0.2,0.3,0.1,0.1} = (0.25, 0.35) → (250, 350)
    expect(out.placements.l1).toEqual({ x: 250, y: 350 })
    expect(out.placements.l2).toEqual({ x: 850, y: 650 })
    expect(out.unplaced).toEqual([])
  })

  it('letterboxes to the map aspect when dimensions are known', () => {
    // 2000x1000 map (aspect 2) into a 1000x1000 world → fitted h=500, offsetY=250
    const out = deriveSimLayout({
      locations: [{ id: 'l1', camp_id: CAMP, map_geometry: geo(0.0, 0.0, 0, 0) }], // center (0,0)
      campMaps: [{ id: CAMP, camp_id: CAMP, kind: null, image_width: 2000, image_height: 1000 }],
      worldWidth: W, worldHeight: H,
    })
    // fit rect x=0,y=250,w=1000,h=500; center (0,0) → (0, 250)
    expect(out.placements.l1).toEqual({ x: 0, y: 250 })
  })

  it('two maps: outdoor location places on the world; indoor room nests in the building rect', () => {
    const out = deriveSimLayout({
      locations: [
        // the building footprint, placed on the OUTDOOR map at a known rect
        { id: 'bldg', camp_id: CAMP, kind: 'building', map_id: 'out', map_geometry: geo(0.4, 0.4, 0.2, 0.2) },
        // an outdoor field, on the outdoor map
        { id: 'field', camp_id: CAMP, kind: 'field', map_id: 'out', map_geometry: geo(0.9, 0.9) },
        // an indoor room, on the INDOOR map, at its center
        { id: 'room', camp_id: CAMP, kind: 'classroom', map_id: 'in', map_geometry: geo(0.45, 0.45) },
      ],
      campMaps: [
        { id: CAMP, camp_id: CAMP, kind: 'outdoor' }, // primary = outdoor (id===camp_id)... but map_id='out' used explicitly
        { id: 'out', camp_id: CAMP, kind: 'outdoor' },
        { id: 'in', camp_id: CAMP, kind: 'indoor' },
      ],
      worldWidth: W, worldHeight: H,
    })
    // building rect in world (fill, no dims): x=400,y=400,w=200,h=200
    // room center (0.5,0.5) → 400 + 0.5*200 = 500, 500
    expect(out.placements.room).toEqual({ x: 500, y: 500 })
    // field center (0.95,0.95) → (950,950)
    expect(out.placements.field).toEqual({ x: 950, y: 950 })
    // building center (0.5,0.5) → (500,500)
    expect(out.placements.bldg).toEqual({ x: 500, y: 500 })
    expect(out.unplaced).toEqual([])
  })

  it('indoor room with NO building placed → unplaced (never guessed)', () => {
    const out = deriveSimLayout({
      locations: [{ id: 'room', camp_id: CAMP, kind: 'classroom', map_id: 'in', map_geometry: geo(0.5, 0.5) }],
      campMaps: [
        { id: CAMP, camp_id: CAMP, kind: 'outdoor' },
        { id: 'in', camp_id: CAMP, kind: 'indoor' },
      ],
      worldWidth: W, worldHeight: H,
    })
    expect(out.placements).toEqual({})
    expect(out.unplaced).toEqual(['room'])
  })

  it('map_id naming a non-existent map → unplaced (no crash)', () => {
    const out = deriveSimLayout({
      locations: [{ id: 'l1', camp_id: CAMP, map_id: 'deleted', map_geometry: geo(0.5, 0.5) }],
      campMaps: [{ id: CAMP, camp_id: CAMP, kind: null }],
      worldWidth: W, worldHeight: H,
    })
    expect(out.unplaced).toEqual(['l1'])
  })

  it('NULL map_id resolves to the primary (id === camp_id) map', () => {
    const out = deriveSimLayout({
      locations: [{ id: 'l1', camp_id: CAMP, map_id: null, map_geometry: geo(0.5, 0.5) }],
      campMaps: [
        { id: 'other', camp_id: CAMP, kind: 'outdoor' },
        { id: CAMP, camp_id: CAMP, kind: 'outdoor' }, // primary
      ],
      worldWidth: W, worldHeight: H,
    })
    // center of {0.5,0.5,0.1,0.1} = (0.55,0.55) → (550,550)
    expect(out.placements.l1).toEqual({ x: 550, y: 550 })
    expect(out.unplaced).toEqual([])
  })

  it('malformed map_geometry → unplaced, not a throw', () => {
    const out = deriveSimLayout({
      locations: [
        { id: 'bad', camp_id: CAMP, map_geometry: '{not json' },
        { id: 'partial', camp_id: CAMP, map_geometry: JSON.stringify({ x: 0.1 }) },
      ],
      campMaps: [{ id: CAMP, camp_id: CAMP, kind: null }],
      worldWidth: W, worldHeight: H,
    })
    expect(out.placements).toEqual({})
    expect(out.unplaced.sort()).toEqual(['bad', 'partial'])
  })
})
