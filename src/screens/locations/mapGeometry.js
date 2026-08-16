// Pure geometry math for the camp map's drag/resize interaction (M6, D8,
// docs/adr/2026-08-16-locations-optional-map.md). No DOM, no React, no
// @dnd-kit — takes a pixel delta and the container's rendered pixel size,
// returns the next {x,y,w,h} fraction rectangle. The component wiring this
// to dnd-kit's onDragMove/onDragEnd is what measures the container and
// supplies deltaPx; this file is the part worth unit testing directly.

export function clamp01(n) {
  return Math.min(1, Math.max(0, n))
}

// Move: shifts x/y by the pixel delta converted to fractions of the
// container; w/h unchanged. Clamped so the box's own extent never exits the
// 0..1 canvas.
export function computeMoveGeometry(initial, deltaPx, container) {
  const dxFrac = container.width > 0 ? deltaPx.x / container.width : 0
  const dyFrac = container.height > 0 ? deltaPx.y / container.height : 0
  const x = clamp01(Math.min(1 - initial.w, Math.max(0, initial.x + dxFrac)))
  const y = clamp01(Math.min(1 - initial.h, Math.max(0, initial.y + dyFrac)))
  return { x, y, w: initial.w, h: initial.h }
}

// Resize: single bottom-right corner handle only (Designer spec Part 4,
// owner-confirmed) — the box's top-left corner (x, y) is the anchor and
// stays fixed; only w/h change. Clamped so the box never grows past the
// canvas edge and never shrinks below a usable minimum.
export const MIN_DIMENSION_FRACTION = 0.02

export function computeResizeGeometry(initial, deltaPx, container) {
  const dwFrac = container.width > 0 ? deltaPx.x / container.width : 0
  const dhFrac = container.height > 0 ? deltaPx.y / container.height : 0
  const w = Math.min(1 - initial.x, Math.max(MIN_DIMENSION_FRACTION, initial.w + dwFrac))
  const h = Math.min(1 - initial.y, Math.max(MIN_DIMENSION_FRACTION, initial.h + dhFrac))
  return { x: initial.x, y: initial.y, w, h }
}

// Tray -> canvas placement (Designer spec "Design judgment calls" #3):
// dropping an unplaced chip onto the canvas synthesizes a starting
// rectangle, centered on the drop point, before the same move-write fires.
// Not load-bearing to the design — a reasoned starting point, adjust freely.
export const TRAY_DEFAULT_W = 0.12
export const TRAY_DEFAULT_H = 0.1

export function defaultTrayGeometry(dropPointFraction) {
  const x = clamp01(Math.min(1 - TRAY_DEFAULT_W, dropPointFraction.x - TRAY_DEFAULT_W / 2))
  const y = clamp01(Math.min(1 - TRAY_DEFAULT_H, dropPointFraction.y - TRAY_DEFAULT_H / 2))
  return { x, y, w: TRAY_DEFAULT_W, h: TRAY_DEFAULT_H }
}
