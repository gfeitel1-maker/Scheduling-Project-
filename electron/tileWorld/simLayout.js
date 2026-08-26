// Pure Day-Simulation layout seed (ADR 2026-08-26 D4, nested-scale-to-fit).
//
// The Tiny Swords viewer used to arrange every building on a fixed ring
// (computeLayout), ignoring where the director actually placed things. This
// function turns the director's REAL map placements (map_geometry, per-map via
// map_id) into scene coordinates, so the sim reflects the facility instead of
// inventing it. It is a SEED, not a second source of truth: anything the
// director hasn't placed falls back to the ring (the `unplaced` set), and it
// never mutates anything.
//
// No React/Phaser/DOM/IPC dependency — pure, testable like buildSchedule.js.
// Kept in electron/tileWorld/ so the standalone viewer.html can load the exact
// same file the tests pin (served by server.js), not a drifting copy.

// The map a NULL map_id resolves to: the original map (id === camp_id), else
// the only/first map. Mirrors src/screens/locations/mapPairModel.primaryMapId,
// but self-contained (the viewer can't import from src/).
function primaryMap(campMaps) {
  if (!campMaps || campMaps.length === 0) return null
  return campMaps.find((m) => m.id === m.camp_id) ?? campMaps[0]
}

function parseGeometry(raw) {
  if (!raw) return null
  try {
    const g = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (![g?.x, g?.y, g?.w, g?.h].every((n) => typeof n === 'number' && Number.isFinite(n))) return null
    return g
  } catch {
    return null
  }
}

// Contain-fit the map's aspect into the world (letterboxed), returning the
// sub-rectangle the map occupies. When dimensions are missing we fill the world
// (no letterbox) — distortion is acceptable for a stylized cartoon (ADR).
function mapFitRect(map, worldWidth, worldHeight) {
  const iw = map?.image_width
  const ih = map?.image_height
  if (!iw || !ih || iw <= 0 || ih <= 0) {
    return { x: 0, y: 0, w: worldWidth, h: worldHeight }
  }
  const mapAspect = iw / ih
  const worldAspect = worldWidth / worldHeight
  if (mapAspect > worldAspect) {
    const h = worldWidth / mapAspect
    return { x: 0, y: (worldHeight - h) / 2, w: worldWidth, h }
  }
  const w = worldHeight * mapAspect
  return { x: (worldWidth - w) / 2, y: 0, w, h: worldHeight }
}

function geomCenter(g) {
  return { cx: g.x + g.w / 2, cy: g.y + g.h / 2 }
}

// Scene pixels — round to kill floating-point noise from the fraction math.
function pt(x, y) {
  return { x: Math.round(x), y: Math.round(y) }
}

// deriveSimLayout({ locations, campMaps, worldWidth, worldHeight })
//   → { placements: { [id]: {x,y} }, unplaced: [id, ...] }
//
// - Outdoor-anchored locations (their map has kind !== 'indoor', or the camp has
//   a single unlabeled map): scale-to-fit their fractional map_geometry onto the
//   world. A kind:'building' location's fitted RECTANGLE becomes the container
//   for indoor rooms.
// - Indoor locations (their map has kind === 'indoor'): scaled into the building
//   rectangle (chained scale-to-fit). If no building is placed, they go unplaced.
// - Anything without a resolvable placement goes to `unplaced` (the caller rings it).
export function deriveSimLayout({ locations = [], campMaps = [], worldWidth, worldHeight } = {}) {
  const placements = {}
  const unplaced = []
  const primary = primaryMap(campMaps)
  const primaryId = primary?.id ?? null

  const mapFor = (loc) => {
    const id = loc.map_id ?? primaryId
    return campMaps.find((m) => m.id === id) ?? null
  }

  // Pass 1: place outdoor-anchored locations, and record the building rectangle.
  let buildingRect = null // world-space {x,y,w,h} of the kind:'building' footprint
  const indoorDeferred = []

  for (const loc of locations) {
    const g = parseGeometry(loc.map_geometry)
    const map = mapFor(loc)
    if (!g || !map) { unplaced.push(loc.id); continue }

    if (map.kind === 'indoor') {
      indoorDeferred.push({ loc, g })
      continue
    }

    // outdoor / unlabeled → place directly in the world
    const fit = mapFitRect(map, worldWidth, worldHeight)
    const c = geomCenter(g)
    placements[loc.id] = pt(fit.x + c.cx * fit.w, fit.y + c.cy * fit.h)
    if (loc.kind === 'building' && !buildingRect) {
      buildingRect = { x: fit.x + g.x * fit.w, y: fit.y + g.y * fit.h, w: g.w * fit.w, h: g.h * fit.h }
    }
  }

  // Pass 2: nest indoor rooms inside the building rectangle. No building placed
  // → the indoor rooms have nowhere to go, so they ring (unplaced), never guessed.
  for (const { loc, g } of indoorDeferred) {
    if (!buildingRect) { unplaced.push(loc.id); continue }
    const c = geomCenter(g)
    placements[loc.id] = pt(buildingRect.x + c.cx * buildingRect.w, buildingRect.y + c.cy * buildingRect.h)
  }

  return { placements, unplaced }
}

// Attach to window when loaded as a plain script in the viewer (server.js serves
// this file). Harmless under Node/vitest where `window` is undefined.
if (typeof window !== 'undefined') window.__deriveSimLayout = deriveSimLayout
