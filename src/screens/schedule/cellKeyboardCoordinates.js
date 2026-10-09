// KeyboardSensor coordinate getter: one arrow press moves the drag rect by one
// whole cell. dnd-kit's default steps 25px, so a ~150px cell took six presses
// and the hit flickered through empty gutters. useDragFSM resolves keyboard
// hits at the translated rect's centre, so stepping centre-to-centre is what
// makes each press land on exactly the neighbouring cell.
const DIRECTIONS = {
  ArrowRight: [1, 0], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowUp: [0, -1],
}

export function cellKeyboardCoordinates(event, { context, currentCoordinates }) {
  const dir = DIRECTIONS[event.code]
  if (!dir) return undefined
  event.preventDefault()
  const rect = context.collisionRect
  if (!rect) return currentCoordinates
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2

  let best = null
  for (const el of document.querySelectorAll('[data-cell-key]')) {
    const r = el.getBoundingClientRect()
    const dx = r.left + r.width / 2 - cx
    const dy = r.top + r.height / 2 - cy
    const along = dx * dir[0] + dy * dir[1]
    const across = Math.abs(dir[0] ? dy : dx)
    if (along < 1 || across > (dir[0] ? r.height : r.width) / 2) continue
    if (!best || along < best.along) best = { along, dx, dy }
  }
  if (!best) return currentCoordinates
  return { x: currentCoordinates.x + best.dx, y: currentCoordinates.y + best.dy }
}
