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
