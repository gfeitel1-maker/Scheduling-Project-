// The single source of a dismissed finding's identity key (T185).
//
// A dismissal (`dismissedFindingKeys`, per-route in-memory Set) must cover
// exactly the finding the director dismissed — not merely its coordinates. A
// coordinate-only key (`groupId|activityId|kind`) masks a genuinely WORSE
// finding at the same coordinates after a slot-edit recompute (the
// `recalcFindings` path in useSlotMutations.js does not reset dismissals): a
// dismissed "UNDERSERVED 2/3" would swallow a later "UNDERSERVED 1/3".
//
// So magnitude-bearing kinds fold their material payload into the key: any
// material change yields a new key, so the stale dismissal no longer matches
// and the finding resurfaces. Binary kinds (presence-only) keep the coordinate
// key — their lifecycle is handled by the regenerate reset (useGeneration.js).
//
// This MUST be the only place the key is spelled. The read side (the
// activeFindings filter) and the write side (dismissFinding) both route through
// it so they cannot drift — the T62 two-places-that-drifted failure class.
export function findingDismissKey(f) {
  const base = `${f.groupId}|${f.activityId}|${f.kind}`
  switch (f.kind) {
    case 'UNDERSERVED':
      return `${base}|got:${f.got}|needed:${f.needed}`
    case 'DISTRIBUTION':
      return `${base}|before:${f.beforeCount}|req:${f.requiredBefore}`
    default:
      // ANCHOR_DUPLICATE, DANGLING_LOCATION, and any future presence-only kind.
      return base
  }
}
