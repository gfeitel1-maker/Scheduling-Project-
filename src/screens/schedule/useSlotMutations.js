import { useEffect, useRef } from 'react'
import { describeWriteFailure } from '../../utils/writeErrorMessage'
import { normalizeName } from '../../ingest/preview.js'
import { isActivityEligibleForGroup } from '../../engine/eligibility'
import { createActivity } from './createActivityHelper'
import { findOverrideId, upsertDayOverride } from '../../utils/dayOverrideCoordinate.js'

// T91: collect the covered tail rows of a span head being replaced, via a
// single walk that covers BOTH span representations identically (owner
// ratified decision 2 — same signal, one walk):
//   - manual merge: head carries flags.expanded, tail is is_span_head:false
//     owning the head's activity (set by expandSlot).
//   - generated/engine: is_span_head chain (head true, N tails false), same
//     activity_id, no flags.expanded (buildSchedule.js).
// Walks time blocks in sort_order starting AFTER the head's own block,
// collecting contiguous following slots (same group+day) that are
// is_span_head === false AND own the head's activity_id — stopping at the
// first non-match. Pure, no state.
// ADR 2026-08-22 §4 (Events overlay placement Slice 1) — which content
// reference a row carries, for span-chain purposes. Electives are
// deliberately excluded: they never span (no call site needs to resolve
// elective_set_id through this), so a row with only elective_set_id set
// resolves to null here, same as a fully-empty row — collectSpanTails'
// guard below then returns [] for it, exactly as before this generalization.
function refField(row) {
  if (row.activity_id != null) return 'activity_id'
  if (row.event_id != null) return 'event_id'
  return null
}

function collectSpanTails(slots, timeBlocks, target, headRow) {
  if (!headRow || headRow.is_span_head === false) return []
  const field = refField(headRow)
  if (!field) return []
  const sortedBlocks = [...timeBlocks].sort((a, b) => a.sort_order - b.sort_order)
  const headIdx = sortedBlocks.findIndex(b => b.id === target.blockId)
  if (headIdx === -1) return []

  const tails = []
  for (let i = headIdx + 1; i < sortedBlocks.length; i++) {
    const blockId = sortedBlocks[i].id
    const row = slots.find(s => s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === blockId)
    if (!row || row.is_span_head !== false || row[field] !== headRow[field]) break
    tails.push(row)
  }
  return tails
}

// ADR 2026-08-21 §3 — ordered stop-condition checks against a freshly-read
// row that would become a NEWLY-covered tail of an extend. Returns true if
// this row STOPS the extend (must not be absorbed): day-end/deleted block
// (row undefined), an anchor, a WEEK_CLOSED block, or a cell holding a
// DIFFERENT activity that is locked or carries an active override. A block
// with no activity (empty) or already holding the SAME activity is never a
// stop condition — it is absorbed (displacing whatever it held, if anything).
function spanStopsAt(row, headActivityId, activities) {
  if (!row) return true
  if (row.is_anchor) return true
  if (row.flags?.WEEK_CLOSED) return true
  if (row.is_overridden) return true
  if (row.activity_id && row.activity_id !== headActivityId) {
    const act = activities.find(a => a.id === row.activity_id)
    if (act?.is_locked) return true
  }
  return false
}

// ADR 2026-08-21 §4 — orphan-tail repair. Pure function over the
// snake_case persisted row shape: for every row with is_span_head===false,
// its immediate predecessor (same group/day, prior sort_order block) must be
// either a head (is_span_head !== false) or an earlier tail in the SAME
// chain, owning the SAME activity_id. A row that fails this is an orphan —
// its predecessor was independently released/replaced by another device
// without this tail being freed in the same gesture. Returns the list of
// orphan rows found (caller decides whether/when to heal — see R2's
// quiescence guard, enforced by the caller, not this pure function).
function repairOrphanSpanTails(slots, timeBlocks) {
  const sortedBlocks = [...timeBlocks].sort((a, b) => a.sort_order - b.sort_order)
  const orphans = []
  for (const row of slots) {
    if (row.is_span_head !== false) continue
    const idx = sortedBlocks.findIndex(b => b.id === row.time_block_id)
    if (idx <= 0) { orphans.push(row); continue }
    const prevBlock = sortedBlocks[idx - 1]
    const prevRow = slots.find(s => s.group_id === row.group_id && s.day_id === row.day_id && s.time_block_id === prevBlock.id)
    // Valid predecessor: either the head of this chain, or an EARLIER tail
    // of the SAME chain (is_span_head:false is fine there too) — both cases
    // collapse to "same activity_id", since a tail only ever carries the
    // activity_id of the head it belongs to.
    const validPredecessor = prevRow && prevRow.activity_id === row.activity_id
    if (!validPredecessor) orphans.push(row)
  }
  return orphans
}

// T107 item 1 (Designer spec 2026-08-21, Decision 1) — pure preview resolver
// for the drag-to-extend gesture's LIVE, per-pointer-move boundary. Re-applies
// spanStopsAt to every block between the head and the pointer's current
// block, against the CURRENT slots — the identical check expandSlot's own R1
// dispatch-time re-validation performs, so the preview and the eventual write
// can never diverge (Maker note #3: do not write a second, divergent
// preview-time check). Returns the ordered list of block ids the preview
// should mark data-drag-over, and — only when the pointer has been dragged
// PAST the last valid block — the block id that should show the one-time
// truncation pulse (data-drag-truncated). No side effects; the caller (a
// hook, not this function) owns writing those to the DOM.
//
// `sortedTimeBlocks` must already be sorted by sort_order — this runs on
// every pointermove of a live drag, so the caller (useSpanExtendDrag) sorts
// once (useMemo) rather than this function re-sorting per call.
function computeSpanExtendPreview(slots, sortedTimeBlocks, activities, { groupId, dayId, headBlockId, headActivityId, pointerBlockId }) {
  const sortedBlocks = sortedTimeBlocks
  const headIdx = sortedBlocks.findIndex(b => b.id === headBlockId)
  const pointerIdx = sortedBlocks.findIndex(b => b.id === pointerBlockId)
  if (headIdx === -1 || pointerIdx === -1 || pointerIdx <= headIdx) {
    return { coveredBlockIds: [], truncatedAtBlockId: null }
  }

  const covered = []
  for (let i = headIdx + 1; i <= pointerIdx; i++) {
    const block = sortedBlocks[i]
    const row = slots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === block.id)
    if (spanStopsAt(row, headActivityId, activities)) {
      return { coveredBlockIds: covered, truncatedAtBlockId: covered[covered.length - 1] ?? headBlockId }
    }
    covered.push(block.id)
  }
  return { coveredBlockIds: covered, truncatedAtBlockId: null }
}

// The per-cell slot / overlay mutation cluster (T32), over the T28 repository.
// Every handler follows the same shape: read the target from `slots` ->
// repo.writeSlotFields/writeOverlayFields -> setActionError on failure ->
// optimistic route setter -> pushUndo({undo, redo}) where it records one.
//
// This hook orchestrates but owns NO state: the route-scoped values and the
// route-PINNED setters come from the injected `routeState` (T31's useRouteState);
// pushUndo, the repo, recalcStats, the geometry getSlot, actMap, setActivities
// and the data lists are injected too.
//
// The delicate part, preserved verbatim: several handlers push undo/redo closures
// that capture `repo`, the route-pinned `setSlots` (bound to the route the entry
// was made on) and the slot ids. Because those closures capture the setter that
// is in scope at the moment the entry is recorded, an undo run after the director
// switches routes still writes the candidate the entry belongs to, never the one
// on screen. (Undo stacks are also cleared on a route switch by the screen's
// transient-reset; the route-pinning is defence in depth.)
//
// `slots` here is the screen's overlap-flagged value (route === 'manual' ?
// withOverlapFlags(rawSlots) : rawSlots), NOT routeState.rawSlots — it is what
// the inline handlers read before extraction, so injecting it keeps prevFlags
// byte-identical to the pre-T32 behaviour.
export function useSlotMutations({
  routeState,
  repo,
  pushUndo,
  setActionError,
  recalcStats,
  recalcFindings,
  getSlot,
  setActivities,
  slots,
  groups,
  activities,
  locations = [],
  days,
  timeBlocks,
  campId,
  // T105 §2 — two distinct lists, never conflated: electiveSetsAll is the
  // render surface (renders one-offs too), durableElectiveSets is the
  // is_reusable=1 reuse surface (CellInlineEditor's exact-match lookup).
  electiveSetsAll = [],
  durableElectiveSets = [],
  // T108 Phase 2 (design §6.1/§6) — overrideModeDayId is the one (week, day)
  // currently in override-authoring mode (ScheduleScreen's toggle), or null.
  // A per-cell check (dayId === overrideModeDayId), not a screen-wide
  // boolean: group view renders every day as a column at once, so a cell on
  // any OTHER day must still route through the normal write path even while
  // some other day's mode is active. `weekId` stamps a day_overrides row's
  // schedule_week_id.
  overrideModeDayId = null,
  weekId,
  // T108 Phase 2 — local mirror of the day_overrides rows (useScheduleData's
  // `dayOverrides`), so a fresh override/pull appears on the grid immediately
  // through the same applyDayOverrides composition, without waiting for a
  // reload. Optional so an unrelated caller/test omitting it just skips the
  // optimistic update (the write itself does not depend on it).
  setDayOverrides,
  // T108 Phase 2 review round 3 (HIGH — re-authoring an existing override
  // silently no-ops). The CURRENT day_overrides rows, read-only here — every
  // override write path below looks up whether a row already exists for its
  // exact coordinate BEFORE deciding an id, via findOverrideId. Defaults to
  // [] so an unrelated caller/test that omits it degrades to "always mint a
  // fresh id" (the pre-fix, first-write-only behavior) rather than crashing.
  dayOverrides = [],
}) {
  function isOverrideModeFor(dayId) {
    return overrideModeDayId != null && dayId === overrideModeDayId
  }

  // Shared write primitive for every override-authoring path (replaceSlot,
  // placeActivityManual, pullOverrideCell): reuses the coordinate's existing
  // row id when one exists (an UPDATE, matching the UNIQUE constraint),
  // mints a fresh id only for a genuinely new coordinate (an INSERT). Both
  // the DB write AND the optimistic array update go through this one
  // function so they can never drift into disagreeing about which id/entry
  // is current — see dayOverrideCoordinate.js and
  // electron/ops/dayOverrides.projections.test.js for why a fresh id per
  // write silently loses data against the real UNIQUE(schedule_week_id,
  // day_id, group_id, time_block_id) constraint.
  async function writeOverrideForCoordinate({ dayId, groupId, blockId, activityId, kind, note = null }) {
    const coord = { weekId, dayId, groupId, blockId }
    const id = findOverrideId(dayOverrides, coord) ?? crypto.randomUUID()
    const fields = {
      schedule_week_id: weekId,
      day_id: dayId,
      group_id: groupId,
      time_block_id: blockId,
      activity_id: activityId,
      kind,
      note,
    }
    await repo.writeDayOverrideFields(id, fields)
    setDayOverrides?.((prev) => upsertDayOverride(prev, { id, ...fields }))
  }
  const {
    route,
    existingTemplates,
    templateId,
    setSlots,
    setOverlays,
  } = routeState

  // T108 (design §6.1, Red Hat Finding #5 fix): a non-override-mode edit onto
  // a cell whose composed row already carries an ACTIVE override must be
  // BLOCKED, not executed and then silently reverted by applyDayOverrides on
  // the next render. Every write path that targets an existing cell calls
  // this before dispatching. In override-authoring mode the guard does not
  // apply — authoring a NEW override onto an already-overridden cell (e.g.
  // replacing a swap) is exactly what override mode is for.
  function overrideGuard(row) {
    if (row?.is_overridden && !isOverrideModeFor(row.day_id)) {
      setActionError('This day has an override on this cell — switch to Override mode to change it.')
      return true
    }
    return false
  }

  // Rebuilt from `activities` rather than injected: expandSlot's undo
  // description reads `actMap.get(id)?.name`, and this is the screen's exact
  // actMap shape (the screen keeps its own copy for the DnD handlers + JSX).
  const actMap = new Map(activities.map(a => [a.id, { ...a, colorIdx: a.id }]))

  // Fresh-read snapshot seam for replaceSlot's undo capture (Deviation A on the
  // 2026-08-12 drag-FSM gesture-correlation ADR). `slots` is this render's prop —
  // a second same-cell drag can call replaceSlot before React re-renders with the
  // first drag's optimistic update, and both calls would then close over the
  // identical stale array, computing the same wrong "previous" activity for undo.
  // slotsRef is kept current by every render AND by replaceSlot's own setSlots
  // updater (which runs in true state-application order regardless of whether a
  // re-render/paint has happened yet), so a snapshot read through it reflects the
  // truest state known at the moment each replaceSlot call actually runs.
  //
  // ASSUMPTION (see the ADR's medium-high confidence note): the in-updater
  // `slotsRef.current = next` writes below depend on `setSlots` being a plain
  // useState setter whose updater is invoked exactly once per call. If this file
  // is ever moved under StrictMode double-invocation or a concurrent feature
  // (startTransition/useDeferredValue) that can call an updater more than once or
  // discard a run, the ref could latch a value from a thrown-away invocation and
  // silently defeat the race-safety this seam exists for. Revisit here, not just
  // in the ADR, if the schedule tree adopts concurrent rendering.
  const slotsRef = useRef(slots)
  useEffect(() => { slotsRef.current = slots }, [slots])

  // Per-cell write-issuance queue (2026-08-12 write-serialization ADR,
  // revised). This is the sole write-ordering mechanism — there is no token
  // ledger anywhere in this file.
  //
  // key: `${route}|${templateId}|${groupId}|${dayId}|${blockId}` -> the last
  // claim registered for that cell, plus a `tail` promise chaining every
  // write issued for that cell. route/templateId are part of cell identity
  // (finding 2 of the reversed design's Red Hat pass) — Manual and Generated
  // are separate schedule_templates rows that share the same group/day/block
  // coordinate space by design (CLAUDE.md, two-routes ADR), so two candidate
  // schedules editing the "same" coordinates must never be treated as the
  // same cell.
  //
  // The fix this queue exists for (finding 1): the previous design gated
  // only the in-memory setSlots call, leaving repo.writeSlotFields fire
  // unconditionally — the op-log replays in seq (arrival) order, not gesture-
  // recency order, so a stale write could still win at the database even
  // after the screen had already corrected itself. This queue instead
  // decides, BEFORE a write is ever handed to repo.writeSlotFields, whether
  // it is still the most recent claim on every cell it touches — a
  // superseded write is never dispatched, not gated after the fact.
  //
  // Lifetime: useSlotMutations is instantiated once per ScheduleScreen mount
  // and persists across route switches (it is not remounted), so this Map is
  // never cleared and lives for the mount's whole lifetime — DELIBERATELY.
  // An earlier revision cleared it on route switch (mirroring undo/redo and
  // the clipboard reset); a Red Hat delta pass found that this reintroduced
  // the exact same-cell DB-divergence race the queue exists to prevent: a
  // write that had already passed its currency check and was mid-dispatch
  // (post step 3, pre step 5 below) would find its cellQueueRef entry wiped,
  // so a subsequent same-cell write saw an empty queue and dispatched
  // CONCURRENTLY instead of waiting on the in-flight tail — reopening the
  // seq-order divergence, and poisoning the undo stack with the stranded
  // write's pushUndo. Persisting the map instead is safe on every axis that
  // matters: (a) route/templateId is baked into cellKey, so an entry from a
  // route the director has left can never be consulted by the route now on
  // screen — no cross-route collision; (b) every claim's tail self-resolves
  // via `run.finally(resolveTail)` below, so no continuation is ever left
  // dangling regardless of which route is on screen when it settles; (c) the
  // map is bounded by the number of distinct cells touched over the whole
  // ScheduleScreen mount lifetime — a few hundred entries at most, not a
  // real leak. Do NOT reintroduce a clear-on-route-switch here.
  const cellQueueRef = useRef(new Map())

  // T105 §5 — the shared choke point useContentRaceFlag reads from. Populated
  // by runMutation's own onSuccess path (below), covering every forward/undo/
  // redo write that touches a cell's activity_id/elective_set_id at one place
  // rather than a separate hook-in per caller. `kind` is
  // `activity:<id>` | `elective:<id>` | `empty`; `atWriteToken` is a
  // Date.now() timestamp for useContentRaceFlag's RECENCY_WINDOW_MS check.
  // Never cleared on route switch here — useContentRaceFlag owns its own
  // reset (it reads this ref, it does not own its lifetime).
  const ownWriteRef = useRef(new Map())

  function cellKey(groupId, dayId, blockId) {
    return `${route}|${templateId}|${groupId}|${dayId}|${blockId}`
  }

  // T107 cleanup — expandSlot's two per-block undo loops (newTails,
  // releasedTails) and splitSlot's one (releasable) each pushed a near-
  // identical granular per-cell undo/redo frame. This is the shared shape:
  // re-read the cell's CURRENT row before undoing (R3's stillMatches guard —
  // a cross-device change since must no-op with a notice, never blind-
  // clobber), then run the write through the same claim/chain/dispatch
  // primitive as every other mutation. `findCurrent`/`isForwardState` are
  // closures because each call site's identity lookup and "is this still the
  // state I expect" check genuinely differ (coordinate-based vs id-based,
  // different field checks) — only the undo/redo/re-read SHAPE is shared,
  // per site (finding #2 in the simplification review: parameterize the
  // fields, don't flatten them).
  function pushGranularCellUndo({ key, description, findCurrent, isForwardState, mismatchMessage, backwardFields, forwardFields, backwardOwnWriteKind, forwardOwnWriteKind }) {
    pushUndo({
      description,
      undo: async () => {
        const current = findCurrent()
        if (!current || !isForwardState(current)) {
          setActionError(mismatchMessage)
          return
        }
        await runMutation({
          keys: [key],
          claimId: crypto.randomUUID(),
          dispatch: async () => { await repo.writeSlotFields(current.id, backwardFields) },
          onSuccess: () => {
            setSlots(prev => {
              const next = prev.map(s => s.id === current.id ? { ...s, ...backwardFields } : s)
              slotsRef.current = next
              return next
            })
          },
          ownWriteKinds: { [key]: backwardOwnWriteKind },
        })
      },
      redo: async () => {
        const current = findCurrent()
        if (!current) return
        await runMutation({
          keys: [key],
          claimId: crypto.randomUUID(),
          dispatch: async () => { await repo.writeSlotFields(current.id, forwardFields) },
          onSuccess: () => {
            setSlots(prev => {
              const next = prev.map(s => s.id === current.id ? { ...s, ...forwardFields } : s)
              slotsRef.current = next
              return next
            })
          },
          ownWriteKinds: { [key]: forwardOwnWriteKind },
        })
      },
    })
  }

  // claimAndRun(keys, claimId, dispatch) — the single write-serialization
  // primitive every mutation (forward, undo, redo; drag or click) goes
  // through, no exceptions (finding 4: no gestureId-undefined bypass).
  //
  // Synchronous part (runs before any `await`, so a second call claiming any
  // of the same `keys` always overwrites this claim before this call's own
  // `dispatch` can run):
  //   1. Snapshot each key's current `tail` (the previous claim's write-in-
  //      flight promise, or undefined if the cell is idle).
  //   2. Install a NEW shared tail — this call's own eventual completion —
  //      on every key in `keys`, together with `claimId`. This is what makes
  //      `keys` an atomic unit: a later claim on ANY one of these keys
  //      immediately supersedes this whole operation, on every key, not just
  //      the one it touched.
  //
  // Async part (chained behind the snapshot above):
  //   3. Wait for every key's PRIOR tail to settle — this is what guarantees
  //      two writes to the same cell are never simultaneously in flight to
  //      the database (finding 1 fixed by construction: there is no seq-
  //      order left to get wrong between them).
  //   4. Re-check, for EVERY key this call touched, that `claimId` is still
  //      the latest claim. If any key has moved on, this call is fully
  //      superseded: `dispatch` is never invoked, for any cell (the
  //      multi-cell atomicity requirement — no half-applied move).
  //   5. Otherwise call `dispatch()` (the actual repo.writeSlotFields calls)
  //      and return its result.
  // Either way, this call's shared tail resolves once step 4/5 finishes, so
  // whatever queued up behind it (steps 1-2 above, for a later claim) can
  // proceed.
  function claimAndRun(keys, claimId, dispatch) {
    const priorTails = keys.map(k => cellQueueRef.current.get(k)?.tail)
    let resolveTail
    const tail = new Promise(resolve => { resolveTail = resolve })
    // `pending: true` (T107 R2) marks this claim as an in-flight LOCAL write on
    // every key it touches, for hasInFlightClaim's benefit below — cellQueueRef
    // itself is never cleared (see its own comment), so `pending` is the only
    // signal for "is anyone writing to this cell right now", not merely
    // "who claimed it last".
    keys.forEach(k => cellQueueRef.current.set(k, { claimId, tail, pending: true }))

    const run = (async () => {
      await Promise.allSettled(priorTails)
      const stillCurrent = keys.every(k => cellQueueRef.current.get(k)?.claimId === claimId)
      if (!stillCurrent) return { dropped: true }
      const result = await dispatch()
      return { dropped: false, result }
    })()

    run.finally(() => {
      resolveTail()
      keys.forEach(k => {
        const entry = cellQueueRef.current.get(k)
        if (entry && entry.claimId === claimId) entry.pending = false
      })
    })
    return run
  }

  // T107 R2 — does this device have an in-flight LOCAL write claim on any
  // cell of this (groupId, dayId)? Consulted by useScheduleData's repair-on-
  // read pass so it never heals an orphan tail out from under a gesture this
  // same device is mid-write on. `cellKey`'s shape is
  // `${route}|${templateId}|${groupId}|${dayId}|${blockId}` — parsed
  // positionally rather than re-deriving via cellKey(), since the check must
  // span every route/template this device has touched this mount, not only
  // the route currently on screen.
  function hasInFlightClaim(groupId, dayId) {
    for (const [key, entry] of cellQueueRef.current) {
      if (!entry.pending) continue
      const parts = key.split('|')
      if (parts[2] === groupId && parts[3] === dayId) return true
    }
    return false
  }

  // runMutation({ keys, claimId, dispatch, getError, onError, onSuccess }) —
  // T82 (F1): names, once, the claim -> chain -> dispatch -> bail-on-drop/error
  // -> onSuccess shape every mutation (forward, undo, redo) repeats around
  // claimAndRun. Every forward/undo/redo call site in this file goes through
  // this instead of calling claimAndRun directly.
  //
  // `dispatch` is still 100% caller-owned, on purpose: whether a given
  // dispatch catches its own write error internally (every forward path, and
  // undo/redo for replaceSlot/expandSlot/splitSlot) or lets one propagate
  // uncaught (placeActivityManual's undo/redo, which never wrapped their
  // write in try/catch) is a pre-existing split this extraction must not
  // paper over — adding a try/catch here would silently change a rejecting
  // undo()/redo() into a resolving one for those two closures. So runMutation
  // never touches `dispatch`'s internals: a caller whose dispatch already
  // catches passes `getError` to report what it caught; a caller whose
  // dispatch doesn't catch simply omits `getError`, and an uncaught throw
  // still propagates out of the `await claimAndRun(...)` below exactly as it
  // did before this extraction.
  //
  // Return shape mirrors what every call site already checked by hand:
  // `{ dropped: true }` on a superseded claim (no onError, no onSuccess —
  // finding 1/2's multi-cell atomicity: nothing fires for a dropped op),
  // `{ error }` when getError() reports one (onError fires, no onSuccess),
  // otherwise onSuccess fires with the dispatch's own result.
  // `ownWriteKinds` (T105 §5, Red Hat fold-in A): an optional
  // `{ [cellKey]: kind }` map recorded into ownWriteRef immediately after a
  // successful onSuccess — the ONE place every own-write is captured,
  // regardless of which of the ~13 call sites below fired. A caller that
  // doesn't touch activity_id/elective_set_id (dismissFlag, releaseCell's
  // is_released, overlays) simply omits it.
  async function runMutation({ keys, claimId, dispatch, getError, onError, onSuccess, ownWriteKinds }) {
    const outcome = await claimAndRun(keys, claimId, dispatch)
    const error = getError ? getError() : undefined
    if (error) {
      onError?.(error)
      return { dropped: false, error }
    }
    if (outcome.dropped) return { dropped: true }
    onSuccess?.(outcome.result)
    if (ownWriteKinds) {
      const atWriteToken = Date.now()
      for (const [key, kind] of Object.entries(ownWriteKinds)) {
        ownWriteRef.current.set(key, { kind, atWriteToken })
      }
    }
    return { dropped: false }
  }

  async function replaceSlot(incoming, target, gestureId) {
    // incoming: { groupId?, dayId?, blockId?, activityId } — coords present only
    // for a grid-to-grid drag; a palette drop supplies activityId alone.
    // target: { groupId, dayId, blockId } — replaceSlot reads its CURRENT row
    // itself rather than trusting a caller-supplied activityId, so a stale drag
    // payload can never overwrite a newer local edit to the target cell.
    if (!existingTemplates[route]) return
    const targetRow = slots.find(s => s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId)
    if (!targetRow || targetRow.is_anchor) return
    if (overrideGuard(targetRow)) return

    // T108 Phase 2 review round 2 (HIGH #1) — replaceSlot is the drag-drop /
    // card-move entry point (dragHandlers.js routes every drop here), the
    // PRIMARY placement gesture. In override-authoring mode for the target
    // cell's day, a drop writes a day_overrides row (kind: swap), never
    // template_slots — same routing placeActivityManual already does for the
    // typeahead path. Deliberately does not touch the source cell (a
    // grid-to-grid drag's source clearing) or span tails: authoring an
    // override is a per-cell diff (design §4), not a move, so this branch
    // returns before any of that logic runs. Undo/redo for override
    // authoring is a deferred follow-up (T113, Governor-accepted) — same
    // posture as placeActivityManual's override branch below.
    if (isOverrideModeFor(target.dayId)) {
      setActionError(null)
      try {
        await writeOverrideForCoordinate({
          dayId: target.dayId, groupId: target.groupId, blockId: target.blockId,
          activityId: incoming.activityId, kind: 'swap',
        })
      } catch (err) {
        setActionError(describeWriteFailure(err, 'That override could not be saved.'))
      }
      return
    }

    const hasSource = incoming.groupId != null && incoming.dayId != null && incoming.blockId != null
    const sourceRow = hasSource
      ? slots.find(s => s.group_id === incoming.groupId && s.day_id === incoming.dayId && s.time_block_id === incoming.blockId)
      : null

    setActionError(null)

    // Every call site synthesizes a claim id when none is supplied — a
    // non-drag caller (click-driven placement/typeahead) is never exempt
    // from the ordering check (finding 4).
    const claimId = gestureId ?? crypto.randomUUID()
    const targetKey = cellKey(target.groupId, target.dayId, target.blockId)
    const sourceKey = sourceRow ? cellKey(incoming.groupId, incoming.dayId, incoming.blockId) : null

    const freshSlots = slotsRef.current
    const freshTargetRow = freshSlots.find(s => s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId) ?? targetRow
    const freshSourceRow = sourceRow
      ? (freshSlots.find(s => s.group_id === incoming.groupId && s.day_id === incoming.dayId && s.time_block_id === incoming.blockId) ?? sourceRow)
      : null
    const prevTargetActivityId = freshTargetRow.activity_id ?? null
    const prevTargetFlags = freshTargetRow.flags ?? {}
    const prevSourceActivityId = freshSourceRow?.activity_id ?? null
    const prevSourceFlags = freshSourceRow?.flags ?? {}

    // T91: span-aware — a replaced HEAD's covered tail(s) must be freed to an
    // empty fresh span head, not left orphaned owning the old activity.
    // collectSpanTails is called once per cell that might be a span head:
    // the drop target, and — when this is a grid-to-grid drag — the source.
    const spanTailRows = collectSpanTails(freshSlots, timeBlocks, target, freshTargetRow)
    const sourceTailRows = freshSourceRow
      ? collectSpanTails(freshSlots, timeBlocks, { groupId: incoming.groupId, dayId: incoming.dayId, blockId: incoming.blockId }, freshSourceRow)
      : []
    // T91 delta-review fix: in ManualBuildView tail cells are independently
    // droppable, so a head can be dragged onto its own tail (or vice versa) —
    // a normal "shrink a merged block" gesture. That cell then gets BOTH an
    // explicit target/source write AND a tail-free from the other side's
    // collectSpanTails walk, racing two conflicting writes to the same row.
    // The explicit drop/clear always wins: exclude any row already covered by
    // a primary write, and dedupe by row id (a cell could otherwise appear in
    // both spanTailRows and sourceTailRows for a degenerate 2-cell blob).
    const primaryIds = new Set([targetRow.id, sourceRow?.id].filter(Boolean))
    const tailRows = []
    const seenTailIds = new Set(primaryIds)
    for (const t of [...spanTailRows, ...sourceTailRows]) {
      if (seenTailIds.has(t.id)) continue
      seenTailIds.add(t.id)
      tailRows.push(t)
    }
    const tailKeys = tailRows.map(t => cellKey(t.group_id, t.day_id, t.time_block_id))
    // Canonical (lexical) order. Not load-bearing for deadlock-freedom today:
    // claimAndRun claims every key in one synchronous pass (no sequential
    // per-key acquisition to interleave), so two multi-cell ops can never
    // block on each other regardless of key order. Kept anyway so the same
    // set of cells always produces the same `keys` array however a caller
    // orders target/source — a stable, order-independent identity for the
    // combined claim. Do NOT remove this on the assumption it's dead: if a
    // future refactor of claimAndRun ever acquires per-key locks sequentially
    // instead of snapshotting synchronously, deadlock-freedom would then
    // depend on this sort, not merely benefit from it.
    const keys = [...new Set([targetKey, sourceKey, ...tailKeys].filter(Boolean))].sort()

    let writeError = null
    const { dropped } = await runMutation({
      keys,
      claimId,
      dispatch: async () => {
        try {
          const writes = [repo.writeSlotFields(targetRow.id, { activity_id: incoming.activityId, flags: {} })]
          if (sourceRow) writes.push(repo.writeSlotFields(sourceRow.id, { activity_id: null, flags: {} }))
          for (const tail of tailRows) {
            // ADR §4 — release whichever field this tail's chain was keyed
            // on (activity_id or event_id), not a hardcoded activity_id.
            writes.push(repo.writeSlotFields(tail.id, { [refField(tail) ?? 'activity_id']: null, is_span_head: true, flags: {} }))
          }
          await Promise.all(writes)
        } catch (err) {
          writeError = err
        }
      },
      getError: () => writeError,
      onError: (err) => setActionError(describeWriteFailure(err, 'That activity could not be placed.')),
      onSuccess: () => {
        setSlots(prev => {
          const next = prev.map(s => {
            if (s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId)
              return { ...s, activity_id: incoming.activityId, flags: {} }
            if (sourceRow && s.group_id === incoming.groupId && s.day_id === incoming.dayId && s.time_block_id === incoming.blockId)
              return { ...s, activity_id: null, flags: {} }
            const tail = tailRows.find(t => t.id === s.id)
            if (tail) return { ...s, [refField(tail) ?? 'activity_id']: null, is_span_head: true, flags: {} }
            return s
          })
          recalcStats(next)
          recalcFindings(next)
          slotsRef.current = next
          return next
        })
      },
      ownWriteKinds: {
        [targetKey]: `activity:${incoming.activityId}`,
        ...(sourceKey ? { [sourceKey]: 'empty' } : {}),
        ...Object.fromEntries(tailRows.map(t => [cellKey(t.group_id, t.day_id, t.time_block_id), 'empty'])),
      },
    })
    if (writeError || dropped) return // fully superseded before dispatch, or write failed: no setSlots, no pushUndo

    const incomingActivity = activities.find(a => a.id === incoming.activityId)
    const occupantActivity = activities.find(a => a.id === prevTargetActivityId)
    const description = occupantActivity
      ? `Replaced ${occupantActivity.name} with ${incomingActivity?.name ?? 'an activity'}`
      : `Placed ${incomingActivity?.name ?? 'an activity'}`

    pushUndo({
      description,
      undo: async () => {
        // Undo/redo go through the identical claim/chain/dispatch path with
        // their own synthesized claim id (finding 3) — an undo run after a
        // newer gesture has since claimed the cell either queues correctly
        // behind it or is itself dropped, never dispatched out of order.
        let undoWriteError = null
        await runMutation({
          keys,
          claimId: crypto.randomUUID(),
          dispatch: async () => {
            try {
              await Promise.all([
                repo.writeSlotFields(targetRow.id, { activity_id: prevTargetActivityId, flags: prevTargetFlags }),
                ...(sourceRow ? [repo.writeSlotFields(sourceRow.id, { activity_id: prevSourceActivityId, flags: prevSourceFlags })] : []),
                // collectSpanTails only ever collects rows where is_span_head
                // is exactly false and its chain field (activity_id or
                // event_id, ADR §4) is set — restore whichever field that
                // was; flags legitimately can be absent on a manual tail, so
                // that fallback stays.
                ...tailRows.map(tail => repo.writeSlotFields(tail.id, {
                  [refField(tail) ?? 'activity_id']: tail[refField(tail) ?? 'activity_id'],
                  is_span_head: false,
                  flags: tail.flags ?? {},
                })),
              ])
            } catch (err) { undoWriteError = err }
          },
          getError: () => undoWriteError,
          onSuccess: () => {
            setSlots(prev => {
              const next = prev.map(s => {
                if (s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId)
                  return { ...s, activity_id: prevTargetActivityId, flags: prevTargetFlags }
                if (sourceRow && s.group_id === incoming.groupId && s.day_id === incoming.dayId && s.time_block_id === incoming.blockId)
                  return { ...s, activity_id: prevSourceActivityId, flags: prevSourceFlags }
                const tail = tailRows.find(t => t.id === s.id)
                if (tail) {
                  const field = refField(tail) ?? 'activity_id'
                  return { ...s, [field]: tail[field], is_span_head: false, flags: tail.flags ?? {} }
                }
                return s
              })
              slotsRef.current = next
              return next
            })
          },
          ownWriteKinds: {
            [targetKey]: prevTargetActivityId ? `activity:${prevTargetActivityId}` : 'empty',
            ...(sourceKey ? { [sourceKey]: prevSourceActivityId ? `activity:${prevSourceActivityId}` : 'empty' } : {}),
            ...Object.fromEntries(tailRows.map(t => {
              const field = refField(t) ?? 'activity_id'
              return [cellKey(t.group_id, t.day_id, t.time_block_id), t[field] ? `activity:${t[field]}` : 'empty']
            })),
          },
        })
      },
      redo: async () => {
        let redoWriteError = null
        await runMutation({
          keys,
          claimId: crypto.randomUUID(),
          dispatch: async () => {
            try {
              await Promise.all([
                repo.writeSlotFields(targetRow.id, { activity_id: incoming.activityId, flags: {} }),
                ...(sourceRow ? [repo.writeSlotFields(sourceRow.id, { activity_id: null, flags: {} })] : []),
                ...tailRows.map(tail => repo.writeSlotFields(tail.id, { [refField(tail) ?? 'activity_id']: null, is_span_head: true, flags: {} })),
              ])
            } catch (err) { redoWriteError = err }
          },
          getError: () => redoWriteError,
          onSuccess: () => {
            setSlots(prev => {
              const next = prev.map(s => {
                if (s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId)
                  return { ...s, activity_id: incoming.activityId, flags: {} }
                if (sourceRow && s.group_id === incoming.groupId && s.day_id === incoming.dayId && s.time_block_id === incoming.blockId)
                  return { ...s, activity_id: null, flags: {} }
                const tail = tailRows.find(t => t.id === s.id)
                if (tail) return { ...s, [refField(tail) ?? 'activity_id']: null, is_span_head: true, flags: {} }
                return s
              })
              slotsRef.current = next
              return next
            })
          },
          ownWriteKinds: {
            [targetKey]: `activity:${incoming.activityId}`,
            ...(sourceKey ? { [sourceKey]: 'empty' } : {}),
            ...Object.fromEntries(tailRows.map(t => [cellKey(t.group_id, t.day_id, t.time_block_id), 'empty'])),
          },
        })
      },
    })
  }

  async function dismissFlag(slotIds, flagName) {
    const updates = slotIds.map(id => {
      const slot = slots.find(s => s.id === id)
      if (!slot) return null
      const newFlags = { ...(slot.flags || {}), [`${flagName}_dismissed`]: true }
      return { id, newFlags }
    }).filter(Boolean)

    setActionError(null)
    try {
      await Promise.all(updates.map(({ id, newFlags }) => repo.writeSlotFields(id, { flags: newFlags })))
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That finding could not be set aside.'))
      return
    }

    setSlots(prev => {
      const next = prev.map(s => {
        const u = updates.find(u => u.id === s.id)
        return u ? { ...s, flags: u.newFlags } : s
      })
      recalcStats(next)
      return next
    })
  }

  async function lockActivity(activityId) {
    setActionError(null)
    try {
      await repo.writeActivityFields(activityId, { is_locked: true })
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That activity could not be locked.'))
      return
    }
    setActivities(prev => prev.map(a => a.id === activityId ? { ...a, is_locked: true } : a))
  }

  async function releaseCell(slotId) {
    setActionError(null)
    try {
      await repo.writeSlotFields(slotId, { is_released: true })
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That cell could not be unlocked.'))
      return
    }
    setSlots(prev => prev.map(s => s.id === slotId ? { ...s, is_released: true } : s))
    // releaseCell only unlocks (is_released), it never touches activity_id/
    // elective_set_id — no ownWriteRef entry belongs here (T105 §5 table:
    // releaseCell's 'empty' entry is for a FUTURE cell-clear action, not this
    // one; unlocking a locked cell does not change its content).
  }

  async function addOverlay({ unitId, dayId, fromBlockOrder, toBlockOrder, label }) {
    if (!existingTemplates[route]) return
    if (!unitId) {
      console.warn('addOverlay: group has no tier_id — cannot create overlay')
      return
    }
    const id = crypto.randomUUID()
    const overlay = { id, template_id: templateId, unit_id: unitId, day_id: dayId, from_block_order: fromBlockOrder, to_block_order: toBlockOrder, label }
    setActionError(null)
    try {
      await repo.writeOverlayFields(id, { template_id: templateId, unit_id: unitId, day_id: dayId, from_block_order: fromBlockOrder, to_block_order: toBlockOrder, label })
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That field trip could not be added.'))
      return
    }
    setOverlays(prev => [...prev, overlay])
  }

  async function removeOverlay(overlayId) {
    setActionError(null)
    try {
      const result = await repo.deleteEntity('template_overlays', overlayId)
      if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
        throw new Error('delete failed')
      }
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That field trip could not be removed.'))
      return
    }
    setOverlays(prev => prev.filter(o => o.id !== overlayId))
  }

  async function updateOverlayRange(overlayId, toBlockOrder) {
    setActionError(null)
    try {
      await repo.writeOverlayFields(overlayId, { to_block_order: toBlockOrder })
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That field trip could not be updated.'))
      return
    }
    setOverlays(prev => prev.map(o => o.id === overlayId ? { ...o, to_block_order: toBlockOrder } : o))
  }

  // activityOverride lets createActivityFromCell place an activity it just
  // created without waiting for a re-render: setActivities is async, so
  // `activities` in this closure would not yet contain the new row within the
  // same call.
  async function placeActivityManual(activityId, groupId, dayId, blockId, activityOverride, gestureId) {
    if (!existingTemplates[route]) return
    const slot = getSlot(slots, groupId, dayId, blockId)
    if (!slot || slot.is_anchor) return
    if (overrideGuard(slot)) return

    const activity = activityOverride ?? activities.find(a => a.id === activityId)
    if (!activity) return

    // T108 Phase 2 (design §6.1): in override-authoring mode FOR THIS CELL'S
    // DAY, a cell edit writes a day_overrides row (kind: swap) instead of
    // template_slots. No undo/redo for override authoring — deferred to
    // T113 (Governor-accepted follow-up); the only way to undo an override
    // today is a snapshot restore (design's §5.2 whole-week restore path).
    if (isOverrideModeFor(dayId)) {
      setActionError(null)
      try {
        await writeOverrideForCoordinate({ dayId, groupId, blockId, activityId, kind: 'swap' })
      } catch (err) {
        setActionError(describeWriteFailure(err, 'That override could not be saved.'))
      }
      return
    }

    const group = groups.find(g => g.id === groupId)
    const eligible = isActivityEligibleForGroup(activity, group)

    // M3b re-key, round 2 (was activity-keyed/place-blind — see history
    // below): `locationFull` on the generated route checks BOTH caps ADR D2
    // keeps distinct, independently — the PLACE's capacity (locations.
    // capacity, keyed by location_id) and the ACTIVITY's own instructor/
    // equipment cap (max_groups_per_slot, keyed by activity_id) — mirroring
    // computeOverlaps' two OVERLAP buckets (src/utils/computeOverlaps.js).
    // Either arm alone can trip UNFILLABLE; there is no min(). An activity
    // with no location_id has no place to be full at, so only its
    // activity-cap arm can fire.
    //
    // Both counts exclude the TARGET GROUP's own existing slot at this
    // (day,block): without that exclusion, dragging a same-place/same-
    // activity activity onto a cell the group already occupies there counts
    // the group's own outgoing slot against the cap it's about to vacate,
    // spuriously flagging UNFILLABLE even though net occupancy is unchanged.
    //
    // Sentinel is `> 0`, not `!= null`, for both caps — a stored cap of 0
    // means "no cap enforced", the same convention computeOverlaps uses for
    // max_groups_per_slot. For locations.capacity this branch is unreachable
    // via the UI/migration (min-1 invariant), so the `> 0` guard there is
    // defensive parity with computeOverlaps rather than a live path.
    const activityLocationId = activity.location_id ?? null
    const placeCapacity = activityLocationId ? locations.find(l => l.id === activityLocationId)?.capacity : undefined
    const coScheduledAtPlace = activityLocationId
      ? slots.filter(s => s.day_id === dayId && s.time_block_id === blockId && s.activity_id && s.group_id !== groupId && actMap.get(s.activity_id)?.location_id === activityLocationId).length
      : 0
    const placeFull = placeCapacity > 0 && coScheduledAtPlace >= placeCapacity

    const activityCapacity = activity.max_groups_per_slot
    const coScheduledForActivity = slots.filter(s => s.day_id === dayId && s.time_block_id === blockId && s.activity_id === activityId && s.group_id !== groupId).length
    const activityFull = activityCapacity > 0 && coScheduledForActivity >= activityCapacity

    const locationFull = placeFull || activityFull

    // Weekly-max enforcement is ActivityPalette disabling the drag source —
    // it's not a per-slot flag kind anymore (UNDERSERVED moved to
    // buildSchedule()'s aggregate findings).
    //
    // On the MANUAL route the placement is always accepted: a director building
    // their own week is never blocked and never has a placement silently
    // corrected. There is no UNFILLABLE here at all — an empty cell is simply
    // not filled yet. After M2, computeOverlaps (src/utils/computeOverlaps.js)
    // surfaces the same two distinguishable OVERLAP markers on the manual
    // route (place-capacity, keyed by location_id, and per-activity
    // instructor/equipment cap, keyed by activity_id) that `locationFull`
    // above checks for the generated route — this is the generated-route/
    // manual-edit-path mirror of both computeOverlaps buckets, not a new flag
    // kind. On the generated route the eligibility half of `flags.UNFILLABLE`
    // is otherwise unchanged.
    const flags = {}
    if (route !== 'manual' && (!eligible || locationFull)) flags.UNFILLABLE = true

    // Routed through the same claim/chain/dispatch primitive as every other
    // write (finding 1 of the reversed-design Red Hat pass, extended to this
    // handler): placeActivityManual only ever targets an empty cell, but two
    // empty-cell writers (a drag drop and a click/typeahead/paste, or two of
    // the same) can still race the same empty cell, and without this guard
    // both `repo.writeSlotFields` calls would fire unconditionally — same
    // silent DB-divergence class the queue exists to close. Every call site
    // synthesizes a claim id when it has none (paste, click, typeahead) —
    // there is no bypass path.
    const claimId = gestureId ?? crypto.randomUUID()
    const key = cellKey(groupId, dayId, blockId)

    const freshSlot = slotsRef.current.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId) ?? slot
    const prevActivityId = freshSlot.activity_id ?? null
    const prevFlags = freshSlot.flags ?? {}

    setActionError(null)
    let writeError = null
    const { dropped } = await runMutation({
      keys: [key],
      claimId,
      dispatch: async () => {
        try {
          await repo.writeSlotFields(slot.id, { activity_id: activityId, flags })
        } catch (err) {
          writeError = err
        }
      },
      getError: () => writeError,
      onError: (err) => setActionError(describeWriteFailure(err, 'That activity could not be placed.')),
      onSuccess: () => {
        setSlots(prev => {
          const next = prev.map(s =>
            s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId
              ? { ...s, activity_id: activityId, flags }
              : s
          )
          recalcStats(next)
          recalcFindings(next)
          slotsRef.current = next
          return next
        })
      },
      ownWriteKinds: { [key]: `activity:${activityId}` },
    })
    if (writeError || dropped) return // fully superseded before dispatch, or write failed: no setSlots, no pushUndo

    const day = days.find(d => d.id === dayId)
    const block = timeBlocks.find(b => b.id === blockId)
    pushUndo({
      description: `Placed ${activity.name} → ${group?.name ?? groupId} ${day?.label ?? dayId} ${block?.name ?? blockId}`,
      undo: async () => {
        await runMutation({
          keys: [key],
          claimId: crypto.randomUUID(),
          dispatch: async () => {
            await repo.writeSlotFields(slot.id, { activity_id: prevActivityId, flags: prevFlags })
          },
          onSuccess: () => {
            setSlots(prev => {
              const next = prev.map(s =>
                s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId
                  ? { ...s, activity_id: prevActivityId, flags: prevFlags }
                  : s
              )
              slotsRef.current = next
              return next
            })
          },
          ownWriteKinds: { [key]: prevActivityId ? `activity:${prevActivityId}` : 'empty' },
        })
      },
      redo: async () => {
        await runMutation({
          keys: [key],
          claimId: crypto.randomUUID(),
          dispatch: async () => {
            await repo.writeSlotFields(slot.id, { activity_id: activityId, flags })
          },
          onSuccess: () => {
            setSlots(prev => {
              const next = prev.map(s =>
                s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId
                  ? { ...s, activity_id: activityId, flags }
                  : s
              )
              slotsRef.current = next
              return next
            })
          },
          ownWriteKinds: { [key]: `activity:${activityId}` },
        })
      },
    })
  }

  // ADR 2026-08-21 — extend a span's head to cover any number of blocks in
  // one gesture. `toBlockId` is the FURTHEST block now covered (inclusive);
  // the range from headBlockId+1..toBlockId is diffed against the span's
  // CURRENT tails (collectSpanTails): tails already covered need no write,
  // newly-covered tails are absorbed (recording what they displaced on their
  // OWN flags.displaced — flags.expanded is retired, see ADR §1), and any
  // former tail no longer covered (a shrink-via-drag) is released to a fresh
  // empty head. Displaced-activity info for EVERY newly-covered tail is
  // computed fresh from its own row, not trusted from the caller, so
  // multi-block extends are correct without the caller resolving N tails'
  // worth of activity names itself.
  async function expandSlot(groupId, dayId, headBlockId, toBlockId, gestureId) {
    if (!existingTemplates[route]) return
    const headSlot = slots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
    if (!headSlot) return
    if (overrideGuard(headSlot)) return

    const headActivityId = headSlot.activity_id

    // R4: fresh timeBlocks at dispatch, not a closure capture.
    const sortedBlocks = [...timeBlocks].sort((a, b) => a.sort_order - b.sort_order)
    const headIdx = sortedBlocks.findIndex(b => b.id === headBlockId)
    const toIdx = sortedBlocks.findIndex(b => b.id === toBlockId)
    if (headIdx === -1 || toIdx === -1 || toIdx <= headIdx) return

    setActionError(null)
    const claimId = gestureId ?? crypto.randomUUID()

    // Fresh-read snapshot (facet 2, same mechanism as replaceSlot's fix).
    const freshSlots = slotsRef.current
    const freshHeadSlot = freshSlots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId) ?? headSlot
    const currentTails = collectSpanTails(freshSlots, timeBlocks, { groupId, dayId, blockId: headBlockId }, freshHeadSlot)
    const currentTailBlockIds = new Set(currentTails.map(t => t.time_block_id))
    // ADR §4 — the field this chain is keyed on (activity_id or event_id),
    // resolved once against the fresh head row so every tail write below
    // absorbs/releases the SAME field the chain is actually keyed on.
    const headField = refField(freshHeadSlot) ?? 'activity_id'
    const headFieldValue = freshHeadSlot[headField]

    // R1: walk from head+1 toward toBlockId, re-applying §3's stop conditions
    // to every NEWLY-covered block against its FRESH row; truncate at the
    // first failure (keep the valid prefix), never abort the whole extend,
    // never absorb the offending block. A block already ours needs no
    // re-check — it's already validly part of this chain.
    const desiredRange = []
    for (let i = headIdx + 1; i <= toIdx; i++) {
      const block = sortedBlocks[i]
      if (!block) break // R4: a targeted block no longer exists
      const row = freshSlots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === block.id)
      if (currentTailBlockIds.has(block.id)) { desiredRange.push({ block, row }); continue }
      if (spanStopsAt(row, headActivityId, activities)) break
      desiredRange.push({ block, row })
    }
    if (desiredRange.length === 0) return

    const desiredBlockIds = new Set(desiredRange.map(d => d.block.id))
    const newTails = desiredRange.filter(d => !currentTailBlockIds.has(d.block.id) && d.row)
    const releasedTails = currentTails.filter(t => !desiredBlockIds.has(t.time_block_id))
    if (newTails.length === 0 && releasedTails.length === 0) return // idempotent double-fire (R4)

    const headKey = cellKey(groupId, dayId, headBlockId)
    const newTailKeys = newTails.map(t => cellKey(groupId, dayId, t.block.id))
    const releasedKeys = releasedTails.map(t => cellKey(t.group_id, t.day_id, t.time_block_id))
    const keys = [headKey, ...newTailKeys, ...releasedKeys].sort()

    function displacedFlagFor(row) {
      if (!row?.activity_id) return {}
      return { displaced: { displaced_activity_id: row.activity_id, displaced_activity_name: actMap.get(row.activity_id)?.name ?? null } }
    }

    let writeError = null
    const { dropped } = await runMutation({
      keys,
      claimId,
      dispatch: async () => {
        try {
          const writes = newTails.map(t => repo.writeSlotFields(t.row.id, {
            [headField]: headFieldValue, is_span_head: false, flags: displacedFlagFor(t.row),
          }))
          for (const t of releasedTails) {
            writes.push(repo.writeSlotFields(t.id, { [headField]: null, is_span_head: true, flags: {} }))
          }
          await Promise.all(writes)
        } catch (err) {
          writeError = err
        }
      },
      getError: () => writeError,
      onError: (err) => setActionError(describeWriteFailure(err, 'That activity could not be made longer.')),
      onSuccess: () => {
        setSlots(prev => {
          const next = prev.map(s => {
            const newTail = newTails.find(t => t.row.id === s.id)
            if (newTail) return { ...s, [headField]: headFieldValue, is_span_head: false, flags: displacedFlagFor(newTail.row) }
            if (releasedTails.some(t => t.id === s.id)) return { ...s, [headField]: null, is_span_head: true, flags: {} }
            return s
          })
          recalcStats(next)
          recalcFindings(next)
          slotsRef.current = next
          return next
        })
      },
      ownWriteKinds: {
        ...Object.fromEntries(newTails.map(t => [cellKey(groupId, dayId, t.block.id), headActivityId ? `activity:${headActivityId}` : 'empty'])),
        ...Object.fromEntries(releasedTails.map(t => [cellKey(t.group_id, t.day_id, t.time_block_id), 'empty'])),
      },
    })
    if (writeError || dropped) return // fully superseded before dispatch, or write failed: no setSlots, no pushUndo

    // Owner-decided #4: the forward write is one atomic multi-cell claim
    // (above), but undo is granular — one frame PER affected block, popped
    // one at a time. R3: each undo/redo re-reads the target row's CURRENT
    // state before writing and no-ops (with a notice) if it no longer
    // matches what this frame expects to be acting on, rather than
    // blind-clobbering a newer edit (e.g. a cross-device split since).
    const headName = actMap.get(headActivityId)?.name ?? 'an activity'
    for (const t of newTails) {
      const blockId = t.block.id
      const key = cellKey(groupId, dayId, blockId)
      const prevFieldValue = t.row[headField] ?? null
      const prevIsSpanHead = t.row.is_span_head ?? true
      const prevFlags = t.row.flags ?? {}
      pushGranularCellUndo({
        key,
        description: `Made ${headName} run longer → ${t.block.name ?? blockId}`,
        findCurrent: () => slotsRef.current.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId),
        isForwardState: (current) => current[headField] === headFieldValue && current.is_span_head === false,
        mismatchMessage: 'This block changed since you extended it — undo skipped for that cell.',
        backwardFields: { [headField]: prevFieldValue, is_span_head: prevIsSpanHead, flags: prevFlags },
        backwardOwnWriteKind: prevFieldValue ? `activity:${prevFieldValue}` : 'empty',
        forwardFields: { [headField]: headFieldValue, is_span_head: false, flags: displacedFlagFor(t.row) },
        forwardOwnWriteKind: `activity:${headFieldValue}`,
      })
    }
    for (const t of releasedTails) {
      const blockId = t.time_block_id
      const key = cellKey(t.group_id, t.day_id, blockId)
      const prevFieldValue = t[headField]
      const prevFlags = t.flags ?? {}
      pushGranularCellUndo({
        key,
        description: `Shortened ${headName} — released a block`,
        findCurrent: () => slotsRef.current.find(s => s.id === t.id),
        isForwardState: (current) => current[headField] == null && current.is_span_head === true,
        mismatchMessage: 'This block changed since you shortened it — undo skipped for that cell.',
        backwardFields: { [headField]: prevFieldValue, is_span_head: false, flags: prevFlags },
        backwardOwnWriteKind: prevFieldValue ? `activity:${prevFieldValue}` : 'empty',
        forwardFields: { [headField]: null, is_span_head: true, flags: {} },
        forwardOwnWriteKind: 'empty',
      })
    }
  }

  // T4 / ADR 2026-08-21 §2 — split a span at any interior block: cutBlockId
  // identifies the covered block to cut AT (owner-decided "un-merge from
  // here", 2026-08-21) — that block and every block after it (in span order)
  // become independent empty heads; blocks before it, including the head
  // itself, keep the head's activity/chain unchanged, now shorter. Omitting
  // cutBlockId (the legacy call shape — every existing call site passes only
  // 3 or 4 args) defaults to the FIRST tail, i.e. "un-merge everything",
  // preserving the old 2-block split behavior byte for byte.
  async function splitSlot(groupId, dayId, headBlockId, gestureId, cutBlockId = null) {
    if (!existingTemplates[route]) return
    const headSlot = slots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
    if (!headSlot) return
    if (overrideGuard(headSlot)) return

    setActionError(null)

    const freshSlots = slotsRef.current
    const freshHeadSlot = freshSlots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId) ?? headSlot
    const tailRows = collectSpanTails(freshSlots, timeBlocks, { groupId, dayId, blockId: headBlockId }, freshHeadSlot)
    if (tailRows.length === 0) return

    const cutIdx = cutBlockId ? tailRows.findIndex(t => t.time_block_id === cutBlockId) : 0
    const releaseFrom = cutIdx === -1 ? 0 : cutIdx
    const candidateRelease = tailRows.slice(releaseFrom)
    if (candidateRelease.length === 0) return
    if (overrideGuard(candidateRelease[0])) return

    // R1: re-check override/lock on every trailing block before releasing
    // it; a block that became locked/overridden since read stops the
    // release AT that block (keeps the earlier valid prefix released, never
    // aborts the whole split).
    const releasable = []
    for (const t of candidateRelease) {
      if (t.is_overridden) break
      releasable.push(t)
    }
    if (releasable.length === 0) return

    const claimId = gestureId ?? crypto.randomUUID()
    const headKey = cellKey(groupId, dayId, headBlockId)
    const tailKeys = releasable.map(t => cellKey(t.group_id, t.day_id, t.time_block_id))
    const keys = [headKey, ...tailKeys].sort()
    // ADR §4 — the field this chain is keyed on (activity_id or event_id).
    const headField = refField(freshHeadSlot) ?? 'activity_id'

    let writeError = null
    const { dropped } = await runMutation({
      keys,
      claimId,
      dispatch: async () => {
        try {
          await Promise.all(releasable.map(t => repo.writeSlotFields(t.id, { [headField]: null, is_span_head: true, flags: {} })))
        } catch (err) {
          writeError = err
        }
      },
      getError: () => writeError,
      onError: (err) => setActionError(describeWriteFailure(err, 'That activity could not be split back into two.')),
      onSuccess: () => {
        setSlots(prev => {
          const next = prev.map(s => releasable.some(t => t.id === s.id) ? { ...s, [headField]: null, is_span_head: true, flags: {} } : s)
          slotsRef.current = next
          return next
        })
      },
      ownWriteKinds: Object.fromEntries(releasable.map(t => [cellKey(t.group_id, t.day_id, t.time_block_id), 'empty'])),
    })
    if (writeError || dropped) return // fully superseded before dispatch, or write failed: no setSlots, no pushUndo

    // T18: was `Split merged slot ${headBlockId}` — a raw uuid in a tooltip.
    const headBlock = timeBlocks.find(b => b.id === headBlockId)
    const dayLabel = days.find(d => d.id === dayId)?.label
    const where = [dayLabel, headBlock?.name].filter(Boolean).join(' ')
    const description = where ? `Split back into two → ${where}` : 'Split back into two'

    // Granular per-block undo frames (same shape as expandSlot's, R3
    // applied): each frame re-reads its own row's CURRENT state before
    // restoring and no-ops (with a notice) if it no longer matches what this
    // frame expects to be undoing FROM.
    for (const t of releasable) {
      const key = cellKey(t.group_id, t.day_id, t.time_block_id)
      const prevFieldValue = t[headField]
      const prevIsSpanHead = t.is_span_head ?? false
      const prevFlags = t.flags ?? {}
      pushGranularCellUndo({
        key,
        description,
        findCurrent: () => slotsRef.current.find(s => s.id === t.id),
        isForwardState: (current) => current[headField] == null && current.is_span_head === true,
        mismatchMessage: 'This block changed since you split it — undo skipped for that cell.',
        backwardFields: { [headField]: prevFieldValue, is_span_head: prevIsSpanHead, flags: prevFlags },
        backwardOwnWriteKind: prevFieldValue ? `activity:${prevFieldValue}` : 'empty',
        forwardFields: { [headField]: null, is_span_head: true, flags: {} },
        forwardOwnWriteKind: 'empty',
      })
    }
  }

  // Cell-created activity from the inline-write editor's "create new" path
  // (2026-08-09 spec): usage-derived rule (min_per_week starts at 1 because
  // this write IS the activity's first placement), max ∞, all-groups
  // eligible, human provenance free from repo.writeActivityFields' existing
  // default. Re-checks for a normalized-name dup defensively — CellInlineEditor
  // already resolves an exact match to onPlace, not onCreateNew, but a second
  // inline-write could race the same name between typing and Enter.
  // Object builder + dedupe/mint logic extracted to createActivityHelper.js
  // (T106) so the weekly path below, createElectiveFromCell's member-creation
  // loop, and the special-day adapter all mint through one shared function —
  // not a duplicate literal (T105 design §1's "Reused vs. new").
  async function createActivityFromCell(name, target) {
    const trimmed = String(name ?? '').trim()
    if (!trimmed) return

    const targetRow = slots.find(s => s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId)
    if (overrideGuard(targetRow)) return

    const dupe = activities.find(a => normalizeName(a.name) === normalizeName(trimmed))
    if (dupe) {
      await placeActivityManual(dupe.id, target.groupId, target.dayId, target.blockId)
      return
    }

    setActionError(null)
    let result
    try {
      result = await createActivity({ name: trimmed, groupId: target.groupId, campId, activities }, repo)
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That activity could not be created.'))
      return
    }

    setActivities(prev => [...prev, result.activity])
    await placeActivityManual(result.activityId, target.groupId, target.dayId, target.blockId, result.activity)
  }

  // T105 §1 — the elective-authoring commit path, sibling to
  // createActivityFromCell rather than a rewrite of it. `memberNames` are
  // resolved to activity ids by reusing createActivityFromCell's own
  // dedupe-by-normalized-name check (not a second matcher); a name with no
  // exact existing activity mints a new one via newActivityDefaultFields.
  // Member creation + the elective_sets/elective_set_activities writes are
  // sequential repo.write calls, the same granularity createActivityFromCell
  // already accepts for the single-activity case — not a bigger transaction
  // (design §1's "Ordering/atomicity note").
  async function createElectiveFromCell(setName, memberNames, target) {
    if (!existingTemplates[route]) return
    const trimmedSet = String(setName ?? '').trim()
    if (!trimmedSet) return

    const targetRow = slots.find(s => s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId)
    if (!targetRow || targetRow.is_anchor) return
    if (overrideGuard(targetRow)) return

    // T108 Phase 2 review round 2 (HIGH #2) — day_overrides has no
    // elective_set_id column (v1 scope, per the schema), so an override
    // cannot point at an elective. Blocked BEFORE any write — including
    // before the fresh-mint path below creates elective_sets/
    // elective_set_activities rows — so override mode can never leave an
    // orphan one-off elective set with nothing placing it.
    if (isOverrideModeFor(target.dayId)) {
      setActionError("Electives can't be overridden for a single day yet — exit Override mode to place an elective.")
      return
    }

    setActionError(null)

    // Reuse-from-existing-durable-set (design §1): an exact name match against
    // the DURABLE list (never electiveSetsAll) places that set directly,
    // rather than minting a duplicate.
    const durableMatch = durableElectiveSets.find(s => normalizeName(s.name) === normalizeName(trimmedSet))
    if (durableMatch) {
      // Never deleted by our own undo (isFreshOneOff stays false) — redo's
      // existence check will therefore always find it, so no recreate path
      // ever fires for a durable-set placement. setName/memberActivityIds
      // are unused in that case.
      await placeElectiveOnCell(durableMatch.id, target, targetRow)
      return
    }

    // Member-activity creation below is NOT undoable — an Enter that mints N
    // new activities has no single undo step that un-creates them. This
    // mirrors createActivityFromCell's already-accepted posture (its own
    // single-activity create is likewise not undone by undoing the
    // placement), extended here to N members instead of one. Accepted,
    // consistent, not a new gap this ticket introduces — flagged rather than
    // silently inherited.
    const memberIds = []
    for (const rawName of memberNames ?? []) {
      const trimmed = String(rawName ?? '').trim()
      if (!trimmed) continue
      let result
      try {
        result = await createActivity({ name: trimmed, groupId: target.groupId, campId, activities }, repo)
      } catch (err) {
        setActionError(describeWriteFailure(err, 'That activity could not be created.'))
        return
      }
      if (result.isNew) setActivities(prev => [...prev, result.activity])
      memberIds.push(result.activityId)
    }
    if (memberIds.length === 0) return // no valid members typed — do not write an empty elective

    // Known latent limitation, accepted rather than fixed here: a colon
    // inside the SET NAME itself (only reachable via a non-inline path —
    // this cell's own grammar splits on the FIRST colon, so `trimmedSet`
    // here can never itself contain one) would not round-trip through the
    // durable-set exact-match reuse lookup in CellInlineEditor (which reads
    // everything before ITS first colon as the query). Not exercised by any
    // shipped authoring surface today; noted for whoever builds the
    // management-screen create/rename path T110 left as its secondary
    // surface.
    const electiveSetId = crypto.randomUUID()
    try {
      await repo.writeElectiveSetFields(electiveSetId, { name: trimmedSet, camp_id: campId, is_reusable: 0 })
      for (const activityId of memberIds) {
        await repo.writeElectiveSetActivityFields(crypto.randomUUID(), { elective_set_id: electiveSetId, activity_id: activityId })
      }
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That elective could not be created.'))
      return
    }

    // memberIds are passed through so a later redo (after an intervening
    // undo deletes this one-off set) can re-create the SAME set — same name,
    // same resolved member activity ids — without re-typing/re-resolving
    // names, per design §1 Redo.
    await placeElectiveOnCell(electiveSetId, target, targetRow, { isFreshOneOff: true, setName: trimmedSet, memberActivityIds: memberIds })
  }

  // Cell write for an elective (both the fresh-mint path and the reuse-a-
  // durable-set path share this): span-head-aware exactly like replaceSlot —
  // collectSpanTails releases any covered tail rows in the same gesture
  // (design §3), and the whole write goes through the same claim/chain/
  // dispatch primitive as every other mutation.
  async function placeElectiveOnCell(electiveSetId, target, targetRow, { isFreshOneOff = false, setName = null, memberActivityIds = [] } = {}) {
    const claimId = crypto.randomUUID()
    // Mutable across repeated undo/redo cycles on this ONE pushUndo entry:
    // a redo that re-creates the set (below) mints a fresh id, and a LATER
    // undo/redo of the SAME entry must act on that fresh id, not the
    // original (now-deleted) one.
    let liveElectiveSetId = electiveSetId
    const targetKey = cellKey(target.groupId, target.dayId, target.blockId)

    const freshSlots = slotsRef.current
    const freshTargetRow = freshSlots.find(s => s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId) ?? targetRow
    const prevTargetActivityId = freshTargetRow.activity_id ?? null
    const prevTargetElectiveSetId = freshTargetRow.elective_set_id ?? null
    const prevTargetFlags = freshTargetRow.flags ?? {}

    const spanTailRows = collectSpanTails(freshSlots, timeBlocks, target, freshTargetRow)
    const tailKeys = spanTailRows.map(t => cellKey(t.group_id, t.day_id, t.time_block_id))
    const keys = [...new Set([targetKey, ...tailKeys])].sort()

    let writeError = null
    const { dropped } = await runMutation({
      keys,
      claimId,
      dispatch: async () => {
        try {
          const writes = [repo.writeSlotFields(targetRow.id, { elective_set_id: electiveSetId, activity_id: null, flags: {} })]
          for (const tail of spanTailRows) {
            writes.push(repo.writeSlotFields(tail.id, { activity_id: null, is_span_head: true, flags: {} }))
          }
          await Promise.all(writes)
        } catch (err) {
          writeError = err
        }
      },
      getError: () => writeError,
      onError: (err) => setActionError(describeWriteFailure(err, 'That elective could not be placed.')),
      onSuccess: () => {
        setSlots(prev => {
          const next = prev.map(s => {
            if (s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId)
              return { ...s, elective_set_id: electiveSetId, activity_id: null, flags: {} }
            if (spanTailRows.some(t => t.id === s.id))
              return { ...s, activity_id: null, is_span_head: true, flags: {} }
            return s
          })
          recalcStats(next)
          recalcFindings(next)
          slotsRef.current = next
          return next
        })
      },
      ownWriteKinds: {
        [targetKey]: `elective:${electiveSetId}`,
        ...Object.fromEntries(tailKeys.map(k => [k, 'empty'])),
      },
    })
    if (writeError || dropped) return

    const set = electiveSetsAll.find(s => s.id === electiveSetId)
    pushUndo({
      description: `Placed ${set?.name ?? 'an elective'}`,
      undo: async () => {
        let undoWriteError = null
        await runMutation({
          keys,
          claimId: crypto.randomUUID(),
          dispatch: async () => {
            try {
              await Promise.all([
                repo.writeSlotFields(targetRow.id, {
                  elective_set_id: prevTargetElectiveSetId,
                  activity_id: prevTargetActivityId,
                  flags: prevTargetFlags,
                }),
                ...spanTailRows.map(tail => repo.writeSlotFields(tail.id, {
                  activity_id: tail.activity_id,
                  is_span_head: false,
                  flags: tail.flags ?? {},
                })),
              ])
            } catch (err) { undoWriteError = err }
          },
          getError: () => undoWriteError,
          onSuccess: () => {
            setSlots(prev => {
              const next = prev.map(s => {
                if (s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId)
                  return { ...s, elective_set_id: prevTargetElectiveSetId, activity_id: prevTargetActivityId, flags: prevTargetFlags }
                const tail = spanTailRows.find(t => t.id === s.id)
                if (tail) return { ...s, activity_id: tail.activity_id, is_span_head: false, flags: tail.flags ?? {} }
                return s
              })
              slotsRef.current = next
              return next
            })
          },
          ownWriteKinds: {
            [targetKey]: prevTargetElectiveSetId ? `elective:${prevTargetElectiveSetId}` : (prevTargetActivityId ? `activity:${prevTargetActivityId}` : 'empty'),
            ...Object.fromEntries(spanTailRows.map(t => [cellKey(t.group_id, t.day_id, t.time_block_id), t.activity_id ? `activity:${t.activity_id}` : 'empty'])),
          },
        })
        // Undo-time one-off cleanup (Red Hat fold-in B): a FRESH read of
        // is_reusable, never the value captured at forward-write time — a set
        // promoted or synced to reusable between the forward write and this
        // undo must survive. Best-effort: a failure here leaves an orphaned
        // one-off elective_sets row, which is harmless (findable/deletable
        // like any hand-created row), never a thrown/blocking error.
        if (isFreshOneOff) {
          try {
            const currentIsReusable = await repo.readElectiveSetIsReusable(liveElectiveSetId)
            const stillOneOff = currentIsReusable === 0 || currentIsReusable === '0' || currentIsReusable === false || currentIsReusable == null
            if (stillOneOff) await repo.deleteElectiveSet(liveElectiveSetId)
          } catch {
            // best-effort — see comment above
          }
        }
      },
      redo: async () => {
        // Redo re-applies the SAME memberActivityIds the original forward
        // write resolved — it never re-resolves member NAMES (design §1).
        // But the SET ROW itself may no longer exist: if undo deleted a
        // not-yet-promoted one-off (the isFreshOneOff branch above), a fresh
        // read here (never a value captured at forward-write or undo time)
        // detects that and RE-CREATES the set + member rows with FRESH ids
        // before writing the cell — replaying a write against the dangling
        // original id would silently lose the director's elective (it would
        // render 'Elective (removed)'), which is a real data-loss bug, not
        // an accepted asymmetry.
        if (isFreshOneOff) {
          const existing = await repo.getElectiveSet(liveElectiveSetId)
          if (!existing) {
            const freshSetId = crypto.randomUUID()
            try {
              await repo.writeElectiveSetFields(freshSetId, { name: setName, camp_id: campId, is_reusable: 0 })
              for (const activityId of memberActivityIds) {
                await repo.writeElectiveSetActivityFields(crypto.randomUUID(), { elective_set_id: freshSetId, activity_id: activityId })
              }
            } catch (err) {
              setActionError(describeWriteFailure(err, 'That elective could not be restored.'))
              return
            }
            liveElectiveSetId = freshSetId
          }
        }
        let redoWriteError = null
        await runMutation({
          keys,
          claimId: crypto.randomUUID(),
          dispatch: async () => {
            try {
              const writes = [repo.writeSlotFields(targetRow.id, { elective_set_id: liveElectiveSetId, activity_id: null, flags: {} })]
              for (const tail of spanTailRows) {
                writes.push(repo.writeSlotFields(tail.id, { activity_id: null, is_span_head: true, flags: {} }))
              }
              await Promise.all(writes)
            } catch (err) { redoWriteError = err }
          },
          getError: () => redoWriteError,
          onSuccess: () => {
            setSlots(prev => {
              const next = prev.map(s => {
                if (s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId)
                  return { ...s, elective_set_id: liveElectiveSetId, activity_id: null, flags: {} }
                if (spanTailRows.some(t => t.id === s.id))
                  return { ...s, activity_id: null, is_span_head: true, flags: {} }
                return s
              })
              slotsRef.current = next
              return next
            })
          },
          ownWriteKinds: {
            [targetKey]: `elective:${liveElectiveSetId}`,
            ...Object.fromEntries(tailKeys.map(k => [k, 'empty'])),
          },
        })
      },
    })
  }

  // T108 (design §6.1): the "pull" override-authoring action — a group is
  // intentionally taken off programming for this cell. Only meaningful in
  // override-authoring mode; the guard still applies so a pull can't silently
  // clobber an existing override outside that mode. No undo/redo — deferred
  // to T113 (Governor-accepted follow-up), same posture as
  // placeActivityManual's and replaceSlot's override-mode branches above.
  async function pullOverrideCell(groupId, dayId, blockId, note = null) {
    if (!existingTemplates[route]) return
    const slot = getSlot(slots, groupId, dayId, blockId)
    if (!slot) return
    if (overrideGuard(slot)) return

    setActionError(null)
    try {
      await writeOverrideForCoordinate({ dayId, groupId, blockId, activityId: null, kind: 'pull', note })
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That override could not be saved.'))
    }
  }

  // T108 Phase 2 (Designer spec §3.3 "Whole-day pull") — batches
  // pullOverrideCell across every non-span, non-anchor block for one group on
  // the active override day, mirroring DayOverridesScreen.jsx's existing
  // delete-then-recreate batch shape (design §3.2), re-scoped to "create N".
  // Skips any block that already has an active override (the per-cell guard
  // inside pullOverrideCell would silently no-op those anyway; skipping here
  // avoids issuing writes doomed to be blocked).
  async function pullOverrideDay(groupId, dayId) {
    const dayBlocks = timeBlocks.filter(b => {
      const s = getSlot(slots, groupId, dayId, b.id)
      return s && !s.is_anchor && !s.is_overridden
    })
    for (const block of dayBlocks) {
      await pullOverrideCell(groupId, dayId, block.id)
    }
  }

  return {
    replaceSlot,
    dismissFlag,
    lockActivity,
    releaseCell,
    addOverlay,
    removeOverlay,
    updateOverlayRange,
    pullOverrideDay,
    placeActivityManual,
    expandSlot,
    splitSlot,
    createActivityFromCell,
    createElectiveFromCell,
    pullOverrideCell,
    ownWriteRef,
    hasInFlightClaim,
  }
}

export { collectSpanTails, spanStopsAt, repairOrphanSpanTails, computeSpanExtendPreview, refField }
