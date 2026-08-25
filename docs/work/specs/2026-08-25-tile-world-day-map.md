# Tile World — Day Map Extension

> **Spec status:** Implementation-ready  
> **Related ADR:** docs/adr/2026-08-24-run-the-day-on-the-map.md  
> **Schema:** v47 → v48  
> **Phaser:** `phaser` npm package (not CDN)

---

## 1. Vision

The Tile World is an isometric grid renderer that gives camps a spatial schedule view with no floor plan photo required. In **Slice 0** (this spec), the director places named locations on a grid by picking a tile type and clicking a cell; the Day Map screen auto-detects that grid placements exist and renders a static Phaser scene showing every location as a tile, with colored group tokens clustered on top. In **Slice 1**, the director can scrub through time blocks with a play/pause control, animating token movement between tiles. In **Slice 2**, tokens become draggable — dropping a group token onto a different location tile proposes a schedule swap, entering the same conflict-resolution flow as the existing drag-and-drop schedule editor. Slice 1 and Slice 2 are out of scope for this spec; they are named here so Slice 0 does not accidentally close doors on them.

---

## 2. Slice 0 scope

**In:**
- Schema v48 migration adding `tile_type`, `grid_x`, `grid_y` to `locations`
- World Builder UI on LocationsScreen (new "Tile World" tab)
- Phaser scene module rendering the static isometric grid
- Day Map mode auto-detection: tile world → floor plan → empty state
- Group tokens at the current time block (colored circles with initials)
- Jam indicators on over-capacity tiles

**Out (explicitly deferred):**
- Time-scrub / animation (Slice 1)
- Drag-to-reschedule (Slice 2)
- Building interiors or multi-floor views
- Animated group movement between tiles
- Asset bundling / sprite atlas optimization (acceptable to load individual PNGs in Slice 0)
- Tile rotation or mirroring controls

---

## 3. Asset plan

### Packs (both CC0, ship inside `src/assets/tiles/`)

| Pack | Source | Role |
|---|---|---|
| **Kenney Isometric Miniature — Farm + Bases** | kenney.nl | Grounds: fields, trees, water, fences, open areas |
| **SBS ISO Town Pack** | screamingbrainstudios.itch.io | Buildings: walls, roofs, cabins, indoor courts |

Tile dimensions: 128 × 64 px (SBS standard; Kenney Miniature matches this scale at 1×). Isometric diamond layout uses these as the base cell size. Store unpacked assets flat under `src/assets/tiles/kenney/` and `src/assets/tiles/sbs/`.

### `tile_type` enum

Seven values, stored as TEXT in SQLite. Maker picks the specific sprite path from these mappings:

| `tile_type` | Pack | Sprite description | Use at camp |
|---|---|---|---|
| `building` | SBS | Ground floor + roof tile (2-layer stack) | Dining hall, infirmary, arts building |
| `pool` | Kenney Farm | Water tile 128×64 | Swimming pool, lake dock |
| `field` | Kenney Farm | Grass field tile | Sports fields, parade ground |
| `cabin` | SBS | Small wood cabin | Bunk cabin areas |
| `court` | SBS | Indoor tile + low walls | Gym, basketball, rec hall |
| `nature` | Kenney Farm | Tree cluster tile | Forest, ropes course, trails |
| `generic` | Kenney Bases | Plain platform tile | Anything that doesn't fit above |

The enum is the discriminant for sprite lookup — it is never displayed as a label to the director. The director sees an icon representing each type in the palette picker (see §5).

---

## 4. Schema v48 migration

### Migration target: `electron/db/localDb.js`

Add three nullable columns to `locations`. All default NULL so existing rows are unaffected. A location is "tile-placed" when all three are non-null.

```sql
-- v48: tile world placement columns
ALTER TABLE locations ADD COLUMN tile_type TEXT CHECK(
  tile_type IS NULL OR tile_type IN ('building','pool','field','cabin','court','nature','generic')
) DEFAULT NULL;
ALTER TABLE locations ADD COLUMN grid_x INTEGER DEFAULT NULL;
ALTER TABLE locations ADD COLUMN grid_y INTEGER DEFAULT NULL;
```

Migration guard in `localDb.js` (follow the existing pattern — check `getSchemaVersion(db) < 48`, run the three ALTER statements, bump `PRAGMA user_version = 48`).

Update `CURRENT_SCHEMA_VERSION` from 47 to 48.

### Migration test file: `electron/db/tileWorld.migration.test.js`

Follow the shape of `campMaps.migration.test.js`:

- Fresh db at v48 has the three columns on `locations`
- Migrated db from v47 has the same columns (schema identical)
- Existing `locations` rows survive migration with `tile_type = NULL`, `grid_x = NULL`, `grid_y = NULL`
- The CHECK constraint rejects values outside the enum
- Re-running the migration (idempotent guard) leaves the schema unchanged
- `CURRENT_SCHEMA_VERSION === 48` assertion (mirrors the `events.migration.test.js` pattern at line 85)

### `writeFields` path

`tile_type`, `grid_x`, `grid_y` are plain columns on `locations`. They are written via the existing `writeFields` IPC path, which already handles `locations` rows. No new IPC handler required.

---

## 5. World Builder UI (LocationsScreen)

### Tab addition

`LocationsScreen.jsx` currently shows a `[ List | Map ]` segmented control when a map image exists, or only the list otherwise. Add a third tab: `[ List | Map | Tile World ]`.

- "Tile World" tab is always visible (not conditional on tile placements existing), so directors can discover it without needing a floor plan first.
- The existing Map tab continues to require `mapRow` with a non-null image (unchanged).
- Tab state is local `useState('list' | 'map' | 'tile-world')`, initialized to `'list'`.

### Tile World tab content

The tab renders two panels side-by-side (desktop) or stacked (narrow):

**Left panel — location list with placement status**

A compact list of all locations. Each row shows:
- Location name
- A small tile-type icon if `tile_type` is set, or a `—` placeholder
- Grid coordinates as `(x, y)` if placed, or "Not placed"
- Clicking a location row selects it (highlights it) and opens the right panel for that location

**Right panel — placement editor**

Appears when a location is selected. Contains:

1. **Tile type palette** — 7 icon buttons in a row, one per `tile_type`. The icon is an SVG representation of the type (inline SVGs, not Phaser assets). Active tile type is highlighted. Clicking changes the selected location's `tile_type` and saves immediately via `writeFields`.

2. **Grid cell picker** — a 20 × 16 isometric preview grid (smaller than the full render grid, for placement only). Each cell is a thin diamond outline. Clicking a cell sets `grid_x` / `grid_y` for the selected location and saves via `writeFields`. The cell that matches the current `grid_x/grid_y` is highlighted. Other already-placed locations appear as dimmed labeled diamonds so the director avoids collision.

3. **Clear placement** button — sets `tile_type = null`, `grid_x = null`, `grid_y = null` and saves. Hidden when the location has no placement.

### Cell collision: sub-quadrant split

If two or more locations are placed on the same cell, do not block — allow it with visual separation. The Phaser scene splits the cell into sub-quadrants: 2 locations get left/right halves, 3 or 4 get corner quarters. Each sub-quadrant renders a scaled-down tile for its location. A warning label ("Two locations share this cell") appears below the grid picker in the builder so the director is aware. A hard collision guard is deferred to Slice 1 if experience shows it's needed.

### Write path

All three fields write through the existing `localClient.writeFields('locations', id, { tile_type, grid_x, grid_y })` call. No new IPC needed.

---

## 6. Phaser scene architecture

### Module: `src/components/locations/TileWorldScene.js`

A pure Phaser `Phaser.Scene` subclass. This module has zero React imports and makes no IPC or `localClient` calls. It receives all data via Phaser's event bus.

```js
// Interface (what React gives it):
scene.events.emit('occupancy', {
  locations: [{ id, name, tile_type, grid_x, grid_y, capacity }],
  placed: [{ locationId, groupId, groupName, groupColor, isJam }],
  // `placed` is derived from deriveOccupancy output filtered to tile-placed locations
})
```

The scene listens for `'occupancy'` in `create()` and re-renders tokens on every emission. It does not store prior state between emissions — it clears and redraws group tokens on each `'occupancy'` event (tiles stay permanent, only token layer is rebuilt).

**Constructor config:**
```js
{
  gridCols: 20,   // fixed for Slice 0
  gridRows: 16,
  tileW: 128,
  tileH: 64,
}
```

### Draw order (painter's algorithm)

Tiles sort by `grid_y * gridCols + grid_x` ascending (back-row first, left-to-right within row). Each tile is a `Phaser.GameObjects.Image` placed at the screen-space isometric origin for its cell:

```
screenX = (grid_x - grid_y) * (tileW / 2) + originX
screenY = (grid_x + grid_y) * (tileH / 2) + originY
```

`originX` and `originY` center the grid in the scene bounds.

### Group tokens

Rendered as `Phaser.GameObjects.Graphics` circles (radius 12px) with a `Phaser.GameObjects.Text` initials label on top. Multiple groups at one location stack horizontally (up to 4 across, then wrap). Drawn after all tiles in a second pass (always on top).

**Jam indicator:** when `isJam === true` for a location, draw an orange ring (stroke, no fill) around the tile's center point, 2px width, radius 28px. Drawn between the tile layer and the token layer.

### React integration: `src/components/locations/TileWorldRenderer.jsx`

A thin React component. Mounts the Phaser `Game` instance in a `useEffect` with a `<div ref={containerRef}>`. Destroys the game in the effect cleanup. Receives `occupancy` as a prop; when it changes, emits `'occupancy'` to the active scene via `game.scene.getScene('TileWorld').events.emit('occupancy', occupancy)`.

```jsx
// Interface:
<TileWorldRenderer occupancy={occupancy} width={w} height={h} />
```

The component never calls `localClient` or reads from any store — it is a pure renderer. Width and height come from a `ResizeObserver` on the container `div` in `DayMapScreen`.

### Phaser configuration

```js
new Phaser.Game({
  type: Phaser.AUTO,
  parent: containerRef.current,
  width, height,
  backgroundColor: 0xf5f3ee,   // matches --bg-subtle token
  scene: [TileWorldScene],
  audio: { noAudio: true },
  input: { mouse: false, touch: false, keyboard: false },  // read-only in Slice 0
})
```

`input` is fully disabled for Slice 0. Slice 2 will enable pointer input.

---

## 7. DayMapScreen integration

### Mode detection

`DayMapScreen.jsx` already loads `locations` from IPC. Add a derived boolean:

```js
const hasTileWorld = useMemo(
  () => data.locations.some((l) => l.grid_x != null && l.grid_y != null),
  [data.locations]
)
```

Mode priority (unchanged existing states stay unchanged):

```
hasTileWorld → render TileWorldRenderer
else mapRow exists → render floor plan (existing)
else → render EmptyState (existing)
```

No user toggle in Slice 0. The mode is auto-detected.

### Occupancy derivation for tile world

`deriveOccupancy` already returns `{ placed: [{ locationId, groupId, ... }] }` (or equivalent). Pass the result through a filter to keep only locations that are tile-placed before sending to `TileWorldRenderer`:

```js
const tileOccupancy = useMemo(() => {
  const raw = deriveOccupancy({ weekId, kind: route, dayId, blockId, ...data })
  const tileLocIds = new Set(
    data.locations
      .filter((l) => l.grid_x != null && l.grid_y != null)
      .map((l) => l.id)
  )
  return {
    locations: data.locations.filter((l) => tileLocIds.has(l.id)),
    placed: raw.placed.filter((p) => tileLocIds.has(p.locationId)),
  }
}, [weekId, route, dayId, blockId, data])
```

Groups at un-placed locations still appear in the "Not on the map" panel (unchanged behavior).

### IPC: `locations` read

`DayMapScreen` already fetches `locations` via `localClient.list('locations', campId)`. The new columns (`tile_type`, `grid_x`, `grid_y`) are returned automatically because the IPC handler does `SELECT *` on the table. No IPC change needed.

---

## 8. Files affected

| File | Change |
|---|---|
| `electron/db/localDb.js` | v48 migration, `CURRENT_SCHEMA_VERSION = 48` |
| `electron/db/tileWorld.migration.test.js` | New — migration test |
| `src/screens/LocationsScreen.jsx` | Add "Tile World" tab, tile palette, grid picker |
| `src/screens/DayMapScreen.jsx` | Mode auto-detect, `TileWorldRenderer` integration |
| `src/components/locations/TileWorldScene.js` | New — Phaser scene |
| `src/components/locations/TileWorldRenderer.jsx` | New — React/Phaser bridge |
| `src/assets/tiles/kenney/` | New — Kenney Miniature sprites (CC0) |
| `src/assets/tiles/sbs/` | New — SBS ISO Town sprites (CC0) |
| `package.json` | Add `"phaser": "^3.x"` |

---

## 9. ADR required

**Yes.** This introduces a new rendering subsystem (Phaser, a second canvas-based render tree alongside React) and extends the `locations` table schema with three columns. File at `docs/adr/2026-08-25-tile-world-phaser-renderer.md`.

Decision to record: Phaser is introduced as an isolated renderer with no React/IPC dependencies (the seam is the `occupancy` event); Phaser is not used anywhere else in the app; the scene is destroyed on unmount. This is the tradeoff — Phaser adds ~1 MB to the bundle but delivers the isometric geometry math and asset loading loop for free, and the isolation invariant (scene never calls IPC) means it can be replaced without touching DayMapScreen logic.

---

## 10. Owner decisions (resolved)

1. **Asset shipping method.** ✅ Assets ship in-repo under `src/assets/tiles/`.

2. **Grid dimensions.** ✅ 20 × 16 fixed for Slice 0 (right-sized for 10–15 locations). Configurable grid deferred.

3. **Tile world + floor plan coexistence.** ✅ User toggle when both exist. DayMapScreen adds a `[ Floor Plan | Tile World ]` control visible only when both modes are populated.

4. **Cell collision.** ✅ Sub-quadrant split (see §5). Warning in builder, visual separation in renderer. No hard block.
