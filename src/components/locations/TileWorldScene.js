import Phaser from 'phaser'

const GRID_COLS = 20
const GRID_ROWS = 16
const TILE_W = 128
const TILE_H = 64

const DEFAULT_PALETTE = ['#2F6B58', '#E07B39', '#5B6FA6', '#9C4E97', '#C4373A']

export function tileScreenPos(gridX, gridY, originX, originY) {
  return {
    x: (gridX - gridY) * (TILE_W / 2) + originX,
    y: (gridX + gridY) * (TILE_H / 2) + originY,
  }
}

export function painterSortKey(loc) {
  return loc.grid_y * GRID_COLS + loc.grid_x
}

export function subQuadrantOffsets(count) {
  if (count <= 1) return [{ dx: 0, dy: 0, scale: 1 }]
  if (count === 2) return [
    { dx: -TILE_W * 0.25, dy: 0, scale: 0.5 },
    { dx: TILE_W * 0.25, dy: 0, scale: 0.5 },
  ]
  return [
    { dx: -TILE_W * 0.25, dy: -TILE_H * 0.25, scale: 0.5 },
    { dx: TILE_W * 0.25, dy: -TILE_H * 0.25, scale: 0.5 },
    { dx: -TILE_W * 0.25, dy: TILE_H * 0.25, scale: 0.5 },
    { dx: TILE_W * 0.25, dy: TILE_H * 0.25, scale: 0.5 },
  ].slice(0, count)
}

const TILE_TYPE_KEY = {
  field: 'tile_field',
  pool: 'tile_pool',
  court: 'tile_court',
  nature: 'tile_nature',
  building: 'tile_building',
  cabin: 'tile_cabin',
  generic: 'tile_generic',
}

export default class TileWorldScene extends Phaser.Scene {
  constructor() {
    super({ key: 'TileWorld' })
    this._tokenLayer = null
    this._jamLayer = null
  }

  preload() {
    const base = 'src/assets/tiles/'
    this.load.image('tile_field', base + 'kenney/bases/base_grass_flat_N.png')
    this.load.image('tile_court', base + 'kenney/bases/base_stone_flat_N.png')
    this.load.image('tile_pool', base + 'kenney/bases/base_stone_flat_N.png')
    this.load.image('tile_generic', base + 'kenney/bases/base_dirt_high_N.png')
    this.load.image('tile_nature', base + 'kenney/bases/square_grass_flat_N.png')
    this.load.image('tile_building', base + 'kenney/farm/woodWallDoorClosed_S.png')
    this.load.image('tile_cabin', base + 'kenney/farm/woodWallWindow_S.png')
    this.load.spritesheet('sbs_buildings1', base + 'sbs/buildings1.png', {
      frameWidth: 64, frameHeight: 96,
    })
    this.load.spritesheet('sbs_roofing', base + 'sbs/roofing.png', {
      frameWidth: 143, frameHeight: 92,
    })
  }

  create() {
    this._tokenLayer = this.add.group()
    this._jamLayer = this.add.group()
    this._tileLayer = this.add.group()

    this.events.on('occupancy', (data) => {
      this._render(data)
    })
  }

  _originForGrid(sceneW, sceneH) {
    const gridPixelW = (GRID_COLS + GRID_ROWS) * (TILE_W / 2)
    const gridPixelH = (GRID_COLS + GRID_ROWS) * (TILE_H / 2)
    return {
      originX: sceneW / 2,
      originY: (sceneH - gridPixelH) / 2 + (GRID_COLS * TILE_H) / 2,
    }
  }

  _render({ locations, placed }) {
    this._tileLayer.clear(true, true)
    this._jamLayer.clear(true, true)
    this._tokenLayer.clear(true, true)

    const { width, height } = this.scale
    const { originX, originY } = this._originForGrid(width, height)

    // Group locations by cell to detect collisions
    const cellMap = new Map()
    for (const loc of locations) {
      if (loc.grid_x == null || loc.grid_y == null) continue
      const key = `${loc.grid_x},${loc.grid_y}`
      if (!cellMap.has(key)) cellMap.set(key, [])
      cellMap.get(key).push(loc)
    }

    // Jam location ids
    const jamLocIds = new Set(placed.filter((p) => p.isJam).map((p) => p.locationId))

    // Sorted for painter's algorithm
    const sorted = [...locations]
      .filter((l) => l.grid_x != null && l.grid_y != null)
      .sort((a, b) => painterSortKey(a) - painterSortKey(b))

    for (const loc of sorted) {
      const key = `${loc.grid_x},${loc.grid_y}`
      const cellLocs = cellMap.get(key) || [loc]
      const idx = cellLocs.indexOf(loc)
      const offsets = subQuadrantOffsets(Math.min(cellLocs.length, 4))
      const off = offsets[idx] ?? offsets[offsets.length - 1]

      const pos = tileScreenPos(loc.grid_x, loc.grid_y, originX, originY)
      const tx = pos.x + off.dx
      const ty = pos.y + off.dy

      const key2 = TILE_TYPE_KEY[loc.tile_type] || 'tile_generic'
      const img = this.add.image(tx, ty, key2)
      img.setScale(off.scale)
      img.setOrigin(0.5, 1)
      if (loc.tile_type === 'pool') img.setTint(0x4499ff)

      if ((loc.tile_type === 'building' || loc.tile_type === 'cabin') && this.textures.exists('sbs_buildings1')) {
        const wall = this.add.sprite(tx, ty - img.displayHeight * 0.5, 'sbs_buildings1', 0)
        wall.setScale(off.scale * 0.5)
        wall.setOrigin(0.5, 1)
        this._tileLayer.add(wall)
      }

      this._tileLayer.add(img)

      if (jamLocIds.has(loc.id)) {
        const ring = this.add.graphics()
        ring.lineStyle(2, 0xff8800, 1)
        ring.strokeCircle(tx, ty - TILE_H * off.scale * 0.5, 28 * off.scale)
        this._jamLayer.add(ring)
      }
    }

    // Token layer: group by location
    const byLocation = new Map()
    for (const p of placed) {
      if (!byLocation.has(p.locationId)) byLocation.set(p.locationId, [])
      byLocation.get(p.locationId).push(p)
    }

    for (const [locId, entries] of byLocation) {
      const loc = locations.find((l) => l.id === locId)
      if (!loc || loc.grid_x == null || loc.grid_y == null) continue

      const key = `${loc.grid_x},${loc.grid_y}`
      const cellLocs = cellMap.get(key) || [loc]
      const idx = cellLocs.indexOf(loc)
      const offsets = subQuadrantOffsets(Math.min(cellLocs.length, 4))
      const off = offsets[idx] ?? offsets[offsets.length - 1]

      const pos = tileScreenPos(loc.grid_x, loc.grid_y, originX, originY)
      const baseX = pos.x + off.dx
      const baseY = pos.y + off.dy - TILE_H * off.scale

      const visible = entries.slice(0, 4)
      for (let i = 0; i < visible.length; i++) {
        const entry = visible[i]
        const tx2 = baseX + (i - (visible.length - 1) / 2) * 28
        const color = entry.groupColor
          ? parseInt(entry.groupColor.replace('#', ''), 16)
          : parseInt(DEFAULT_PALETTE[i % DEFAULT_PALETTE.length].replace('#', ''), 16)

        const circle = this.add.graphics()
        circle.fillStyle(color, 1)
        circle.fillCircle(tx2, baseY, 12)
        this._tokenLayer.add(circle)

        const initials = (entry.groupName || '?').slice(0, 2).toUpperCase()
        const label = this.add.text(tx2, baseY, initials, {
          fontSize: '9px',
          color: '#ffffff',
          fontFamily: 'sans-serif',
        })
        label.setOrigin(0.5, 0.5)
        this._tokenLayer.add(label)
      }
    }
  }
}
