# Payload-addressed finding dismissal — design

**Ticket:** T185 · **Date:** 2026-09-16 · **Status:** approved

## Problem
`dismissedFindingKeys` keys a dismissed schedule finding by `groupId|activityId|kind` with no material
payload. On the generated route, the slot-edit recompute path (`recalcFindings` in
`useSlotMutations.js`) recomputes findings without resetting dismissals, so a finding that becomes
materially worse at the same coordinates (e.g. UNDERSERVED 2/3 → 1/3) is masked by the stale
coordinate-only dismissal. See the ticket for the full premise correction (the regenerate path already
resets; the slot-edit path is the real hole).

## Approach
Include the finding's *material* fields in the dismissal key, resolved through a single shared pure
helper so the read-key (the `activeFindings` filter) and the write-key (`dismissFinding`) cannot drift.

```js
// src/screens/schedule/findingKey.js
export function findingDismissKey(f) {
  const base = `${f.groupId}|${f.activityId}|${f.kind}`
  switch (f.kind) {
    case 'UNDERSERVED':  return `${base}|got:${f.got}|needed:${f.needed}`
    case 'DISTRIBUTION': return `${base}|before:${f.beforeCount}|req:${f.requiredBefore}`
    default:             return base  // ANCHOR_DUPLICATE, DANGLING_LOCATION, unknown: binary presence
  }
}
```

Any change to a magnitude-bearing finding's material payload yields a new key, so the old dismissal no
longer matches and the finding resurfaces. Binary kinds keep pure coordinate identity (their lifecycle
is already handled by the regenerate reset).

## Components & data flow
- **`findingDismissKey(finding)`** — pure, no deps. Input: a raw finding (from `computeFindings`,
  carrying its magnitude fields). Output: a string key. The single source of the key format.
- **`ScheduleScreen.activeFindings`** — `findings.filter(f => !dismissedFindingKeys.has(findingDismissKey(f)))`.
- **`ScheduleScreen.findingsRows`** — each active-finding row carries `dismissKey: findingDismissKey(f)`,
  computed from the raw finding (which still has the magnitude), so the dismiss handler needs nothing
  the row doesn't already hold.
- **`dismissFinding(dismissKey)`** — adds the precomputed key to the route's dismissed `Set`.
- **`dismissFindingsRow(row)`** — for a finding row, calls `dismissFinding(row.dismissKey)`.

## What does NOT change
- The `Set`-of-strings representation and its per-route storage (`dismissedByRoute`).
- Every existing dismissal reset (generate/placeAnchors/restore/load) — untouched; still correct.
- UNFILLABLE/OVERLAP/WEEK_CLOSED dismissal (per-slot flags, a separate mechanism).
- No persistence, migration, op-log, or engine change.

## Error handling / edge cases
- A finding missing a magnitude field (shouldn't happen for its kind) serializes as `undefined` in the
  key — deterministic and self-consistent (read and write both go through the same helper), so no
  mismatch. The binary `default` branch covers kinds with no magnitude.
- Improving-but-still-present finding resurfaces (Set has no memory of the old magnitude). Accepted.

## Testing
1. `src/screens/schedule/findingKey.test.js` (pure):
   - identical coords + identical magnitude → equal keys;
   - same coords, worse magnitude (2/3 → 1/3) → different keys;
   - DISTRIBUTION keys on beforeCount/requiredBefore;
   - ANCHOR_DUPLICATE / DANGLING_LOCATION / unknown kind → base key, magnitude fields ignored.
2. Masking scenario (component/hook-level in the ScheduleScreen suite):
   - dismiss UNDERSERVED 2/3 → recompute at 1/3 → finding is in `activeFindings` again;
   - dismiss UNDERSERVED 2/3 → recompute still 2/3 → stays dismissed.
