// Time blocks whose clock ranges intersect (audit A6): a group can hold at most
// one placement across such blocks on a day. Touching ranges (10:00 end, 10:00
// start) do not intersect. A block with a missing or unparseable time, or an
// overnight one (end <= start), overlaps nothing.
// Shared by buildSchedule (refuses the clash) and computeOverlaps (flags one).

function minutes(t) {
  if (typeof t !== 'string') return null
  const [h, m] = t.split(':').map(Number)
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null
}

// blockId → [peer block, ...] for every block that overlaps at least one other.
export function overlappingBlockPeers(timeBlocks) {
  const ranged = (timeBlocks || [])
    .map(b => ({ b, start: minutes(b.start_time), end: minutes(b.end_time) }))
    .filter(r => r.start != null && r.end != null && r.end > r.start)
  const peers = new Map()
  for (const x of ranged) {
    for (const y of ranged) {
      if (x.b.id === y.b.id || !(x.start < y.end && y.start < x.end)) continue
      if (!peers.has(x.b.id)) peers.set(x.b.id, [])
      peers.get(x.b.id).push(y.b)
    }
  }
  return peers
}

// T219: the blocks (in the given day order) that start exactly when the block before them ends.
// An imported elective spans two blocks only across such a seam: a time gap, or a missing time,
// keeps two periods separate, so two chugim around a break are never fused into one.
export function blocksThatContinue(orderedBlocks) {
  const out = new Set()
  for (let i = 1; i < (orderedBlocks || []).length; i++) {
    const end = minutes(orderedBlocks[i - 1].end_time)
    const start = minutes(orderedBlocks[i].start_time)
    if (end != null && end === start) out.add(orderedBlocks[i].id)
  }
  return out
}
