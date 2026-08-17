// The map's write-serialization primitive (M6, D7,
// docs/adr/2026-08-16-locations-optional-map.md). This is a COPY of
// claimAndRun from src/screens/schedule/useSlotMutations.js:150-176 — the
// shipped write-serialization primitive established by
// docs/adr/2026-08-12-drag-live-write-serialization.md — verbatim in
// structure, simplified for the map's narrower shape. Per that ADR's mandate
// and ARCHITECTURE_STANDARD.md §9: copy the pattern per new consumer, do NOT
// extract a shared abstraction between this hook and useSlotMutations on a
// first pass. A shared abstraction is worth building only once a third
// consumer exists or the two diverge in a way that makes keeping them in
// sync error-prone — neither is true today.
//
// Differences from useSlotMutations' claimAndRun, all narrowing, none new:
//   - Key: locationKey(locationId) = locationId. No route/template dimension
//     — the schedule grid needed route|templateId|groupId|dayId|blockId
//     because two candidate schedules share one coordinate space
//     (docs/adr/2026-07-28-plural-candidate-schedules-per-camp.md); the map
//     has no second "route" to collide with, so the key collapses to the one
//     thing that varies: which place.
//   - No multi-cell atomicity. A location drag/resize touches exactly one
//     location's rectangle — always keys = [locationKey(locationId)].
//     claimAndRun's array-of-keys signature is kept as-is (not narrowed to a
//     single string) purely so the copy is a copy, not a rewrite.
//   - One op per gesture, on release: pointer-move never writes; writeGeometry
//     is called once, on pointer-up, with the final {x,y,w,h}.
//   - Queue LIFETIME: MODULE scope, not a per-hook-instance useRef. Unlike
//     ScheduleScreen (a long-lived per-session mount, where useSlotMutations'
//     cellQueueRef living in a useRef is correct), LocationsScreen fully
//     unmounts/remounts on ordinary sidebar navigation (App.jsx's
//     SCREENS[screen] switch). A useRef queue would lose all knowledge of an
//     in-flight write the instant the screen unmounts — a fresh mount's
//     fresh Map has no prior tail for the location, so a same-location write
//     issued right after remount would dispatch CONCURRENTLY with the
//     still-in-flight older write instead of queuing behind it: the exact
//     DB-divergence race this queue exists to prevent, just reopened by a
//     lifetime mismatch rather than an explicit clear. Module scope survives
//     the remount, giving the hook the same effective lifetime the pattern
//     assumes. Fixed under a Red Hat NEEDS-FIX on the M6 fix round; pinned by
//     the "queues behind a still in-flight write from the prior mount" test
//     in useLocationGeometryMutations.test.js.
//
// Per-location write-issuance queue, keyed by locationId alone (location ids
// are globally unique — this app is one camp per device db, so no cross-camp
// key collision is even reachable). NEVER cleared — the same deliberate
// choice useSlotMutations.js's cellQueueRef makes, for the identical reason
// documented there (docs/adr/2026-08-12-drag-live-write-serialization.md): a
// clear reopens the exact same-cell DB-divergence race the queue exists to
// prevent, because a write that already passed its currency check and is
// mid-dispatch can find its queue entry wiped out from under it. Every
// claim's tail self-resolves via `run.finally(resolveTail)` below regardless
// of whether anything is still mounted to read the result, and this Map is
// bounded by the number of distinct locations ever touched across the app's
// lifetime — small (tens, not thousands) for any real camp — not a leak.
const geometryWriteQueue = new Map()

export function useLocationGeometryMutations({ repository }) {
  function locationKey(locationId) {
    return locationId
  }

  // claimAndRun(keys, claimId, dispatch) — copied verbatim in structure from
  // useSlotMutations.js. See that file's own comment for the full
  // synchronous/async breakdown; unchanged here.
  function claimAndRun(keys, claimId, dispatch) {
    const priorTails = keys.map((k) => geometryWriteQueue.get(k)?.tail)
    let resolveTail
    const tail = new Promise((resolve) => { resolveTail = resolve })
    keys.forEach((k) => geometryWriteQueue.set(k, { claimId, tail }))

    const run = (async () => {
      await Promise.allSettled(priorTails)
      const stillCurrent = keys.every((k) => geometryWriteQueue.get(k)?.claimId === claimId)
      if (!stillCurrent) return { dropped: true }
      const result = await dispatch()
      return { dropped: false, result }
    })()

    run.finally(resolveTail)
    return run
  }

  // One op per gesture, on release (D7). `geometry` is the final
  // {x,y,w,h} fractions (0..1) the gesture (move or resize) produced — the
  // FSM computes this; this hook only serializes and writes it.
  // `repo.writeFields('locations', locationId, { map_geometry: ... })`
  // reuses the SAME field-write primitive LocationsScreen.jsx's existing
  // setupCrudRepository instance already exposes for capacity/notes/
  // sort_order on this same table — map_geometry is one more field on an
  // already-wired entity, not a new write path.
  async function writeGeometry(locationId, geometry, gestureId) {
    const claimId = gestureId ?? crypto.randomUUID()
    const keys = [locationKey(locationId)]
    return claimAndRun(keys, claimId, () =>
      repository.writeFields('locations', locationId, { map_geometry: JSON.stringify(geometry) })
    )
  }

  return { writeGeometry }
}
