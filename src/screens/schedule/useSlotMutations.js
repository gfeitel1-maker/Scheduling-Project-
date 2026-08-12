import { useEffect, useRef } from 'react'
import { describeWriteFailure } from '../../utils/writeErrorMessage'
import { normalizeName } from '../../ingest/preview.js'

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
  days,
  timeBlocks,
  campId,
}) {
  const {
    route,
    existingTemplates,
    templateId,
    setSlots,
    setOverlays,
  } = routeState

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

  function cellKey(groupId, dayId, blockId) {
    return `${route}|${templateId}|${groupId}|${dayId}|${blockId}`
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
    keys.forEach(k => cellQueueRef.current.set(k, { claimId, tail }))

    const run = (async () => {
      await Promise.allSettled(priorTails)
      const stillCurrent = keys.every(k => cellQueueRef.current.get(k)?.claimId === claimId)
      if (!stillCurrent) return { dropped: true }
      const result = await dispatch()
      return { dropped: false, result }
    })()

    run.finally(resolveTail)
    return run
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
    // Canonical (lexical) order. Not load-bearing for deadlock-freedom today:
    // claimAndRun claims every key in one synchronous pass (no sequential
    // per-key acquisition to interleave), so two multi-cell ops can never
    // block on each other regardless of key order. Kept anyway so the same
    // pair of cells always produces the same `keys` array however a caller
    // orders target/source — a stable, order-independent identity for the
    // combined claim. Do NOT remove this on the assumption it's dead: if a
    // future refactor of claimAndRun ever acquires per-key locks sequentially
    // instead of snapshotting synchronously, deadlock-freedom would then
    // depend on this sort, not merely benefit from it.
    const keys = sourceKey ? [targetKey, sourceKey].sort() : [targetKey]

    const freshSlots = slotsRef.current
    const freshTargetRow = freshSlots.find(s => s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId) ?? targetRow
    const freshSourceRow = sourceRow
      ? (freshSlots.find(s => s.group_id === incoming.groupId && s.day_id === incoming.dayId && s.time_block_id === incoming.blockId) ?? sourceRow)
      : null
    const prevTargetActivityId = freshTargetRow.activity_id ?? null
    const prevTargetFlags = freshTargetRow.flags ?? {}
    const prevSourceActivityId = freshSourceRow?.activity_id ?? null
    const prevSourceFlags = freshSourceRow?.flags ?? {}

    let writeError = null
    const outcome = await claimAndRun(keys, claimId, async () => {
      try {
        const writes = [repo.writeSlotFields(targetRow.id, { activity_id: incoming.activityId, flags: {} })]
        if (sourceRow) writes.push(repo.writeSlotFields(sourceRow.id, { activity_id: null, flags: {} }))
        await Promise.all(writes)
      } catch (err) {
        writeError = err
      }
    })

    if (writeError) {
      setActionError(describeWriteFailure(writeError, 'That activity could not be placed.'))
      return
    }
    if (outcome.dropped) return // fully superseded before dispatch: no write, no setSlots, no pushUndo

    setSlots(prev => {
      const next = prev.map(s => {
        if (s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId)
          return { ...s, activity_id: incoming.activityId, flags: {} }
        if (sourceRow && s.group_id === incoming.groupId && s.day_id === incoming.dayId && s.time_block_id === incoming.blockId)
          return { ...s, activity_id: null, flags: {} }
        return s
      })
      recalcStats(next)
      recalcFindings(next)
      slotsRef.current = next
      return next
    })

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
        const undoOutcome = await claimAndRun(keys, crypto.randomUUID(), async () => {
          try {
            await Promise.all([
              repo.writeSlotFields(targetRow.id, { activity_id: prevTargetActivityId, flags: prevTargetFlags }),
              ...(sourceRow ? [repo.writeSlotFields(sourceRow.id, { activity_id: prevSourceActivityId, flags: prevSourceFlags })] : []),
            ])
          } catch (err) { undoWriteError = err }
        })
        if (undoWriteError || undoOutcome.dropped) return
        setSlots(prev => {
          const next = prev.map(s => {
            if (s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId)
              return { ...s, activity_id: prevTargetActivityId, flags: prevTargetFlags }
            if (sourceRow && s.group_id === incoming.groupId && s.day_id === incoming.dayId && s.time_block_id === incoming.blockId)
              return { ...s, activity_id: prevSourceActivityId, flags: prevSourceFlags }
            return s
          })
          slotsRef.current = next
          return next
        })
      },
      redo: async () => {
        let redoWriteError = null
        const redoOutcome = await claimAndRun(keys, crypto.randomUUID(), async () => {
          try {
            await Promise.all([
              repo.writeSlotFields(targetRow.id, { activity_id: incoming.activityId, flags: {} }),
              ...(sourceRow ? [repo.writeSlotFields(sourceRow.id, { activity_id: null, flags: {} })] : []),
            ])
          } catch (err) { redoWriteError = err }
        })
        if (redoWriteError || redoOutcome.dropped) return
        setSlots(prev => {
          const next = prev.map(s => {
            if (s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId)
              return { ...s, activity_id: incoming.activityId, flags: {} }
            if (sourceRow && s.group_id === incoming.groupId && s.day_id === incoming.dayId && s.time_block_id === incoming.blockId)
              return { ...s, activity_id: null, flags: {} }
            return s
          })
          slotsRef.current = next
          return next
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

    const activity = activityOverride ?? activities.find(a => a.id === activityId)
    if (!activity) return

    const group = groups.find(g => g.id === groupId)
    const tierIds = activity.eligible_tier_ids || []
    const groupIds = activity.eligible_group_ids || []
    const eligible = (tierIds.length === 0 && groupIds.length === 0)
      || tierIds.includes(group?.tier_id)
      || groupIds.includes(groupId)

    const coScheduled = slots.filter(s => s.day_id === dayId && s.time_block_id === blockId && s.activity_id === activityId).length
    const locationFull = activity.max_groups_per_slot != null && coScheduled >= activity.max_groups_per_slot

    // Weekly-max enforcement is ActivityPalette disabling the drag source —
    // it's not a per-slot flag kind anymore (UNDERSERVED moved to
    // buildSchedule()'s aggregate findings).
    //
    // On the MANUAL route the placement is always accepted: a director building
    // their own week is never blocked and never has a placement silently
    // corrected. An over-booking is surfaced instead, as a derived OVERLAP
    // marker computed from the week on screen (src/utils/computeOverlaps.js),
    // and there is no UNFILLABLE here at all — an empty cell is simply not
    // filled yet. On the generated route the existing behaviour is unchanged.
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
    const outcome = await claimAndRun([key], claimId, async () => {
      try {
        await repo.writeSlotFields(slot.id, { activity_id: activityId, flags })
      } catch (err) {
        writeError = err
      }
    })

    if (writeError) {
      setActionError(describeWriteFailure(writeError, 'That activity could not be placed.'))
      return
    }
    if (outcome.dropped) return // fully superseded before dispatch: no write, no setSlots, no pushUndo

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

    const day = days.find(d => d.id === dayId)
    const block = timeBlocks.find(b => b.id === blockId)
    pushUndo({
      description: `Placed ${activity.name} → ${group?.name ?? groupId} ${day?.label ?? dayId} ${block?.name ?? blockId}`,
      undo: async () => {
        const undoOutcome = await claimAndRun([key], crypto.randomUUID(), async () => {
          await repo.writeSlotFields(slot.id, { activity_id: prevActivityId, flags: prevFlags })
        })
        if (undoOutcome.dropped) return
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
      redo: async () => {
        const redoOutcome = await claimAndRun([key], crypto.randomUUID(), async () => {
          await repo.writeSlotFields(slot.id, { activity_id: activityId, flags })
        })
        if (redoOutcome.dropped) return
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
    })
  }

  async function expandSlot(groupId, dayId, headBlockId, tailBlockId, tailActivityId, tailActivityName, tailBlockName, dayLabel, gestureId) {
    if (!existingTemplates[route]) return
    const headSlot = slots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
    const tailSlot = slots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
    if (!headSlot || !tailSlot) return

    const headActivityId = headSlot.activity_id
    const existingFlags = headSlot.flags || {}
    const newFlags = {
      ...existingFlags,
      expanded: {
        displacedActivityId: tailActivityId,
        displacedActivityName: tailActivityName,
        from_block: tailBlockId,
      },
    }

    setActionError(null)

    const claimId = gestureId ?? crypto.randomUUID()
    const headKey = cellKey(groupId, dayId, headBlockId)
    const tailKey = cellKey(groupId, dayId, tailBlockId)
    const keys = [headKey, tailKey].sort()

    // Fresh-read snapshot (facet 2, same mechanism as replaceSlot's fix): read
    // the undo-relevant "previous" values off slotsRef, not the `slots` prop
    // this call closed over, so a second racing expand/split on the same head
    // cell can't compute an identical, stale "previous" value.
    const freshSlots = slotsRef.current
    const freshHeadSlot = freshSlots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId) ?? headSlot
    const freshTailSlot = freshSlots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId) ?? tailSlot
    const prevHeadFlags = freshHeadSlot.flags ?? {}
    const prevTailActivityId = freshTailSlot.activity_id ?? null

    let writeError = null
    const outcome = await claimAndRun(keys, claimId, async () => {
      try {
        // Update tail slot: now owned by head activity, marked as tail (is_span_head = false)
        await repo.writeSlotFields(tailSlot.id, { activity_id: headActivityId, is_span_head: false })
        // Write flag to head slot
        await repo.writeSlotFields(headSlot.id, { flags: newFlags })
      } catch (err) {
        writeError = err
      }
    })

    if (writeError) {
      setActionError(describeWriteFailure(writeError, 'That activity could not be made longer.'))
      return
    }
    if (outcome.dropped) return // fully superseded before dispatch: no write, no setSlots, no pushUndo

    // Update local state
    setSlots(prev => {
      const next = prev.map(s => {
        if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId) {
          return { ...s, activity_id: headActivityId, is_span_head: false }
        }
        if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId) {
          return { ...s, flags: newFlags }
        }
        return s
      })
      slotsRef.current = next
      return next
    })

    pushUndo({
      description: `Made ${headActivityId ? actMap.get(headActivityId)?.name ?? 'an activity' : 'an activity'} run longer → ${tailBlockName} ${dayLabel}`,
      undo: async () => {
        let undoWriteError = null
        const undoOutcome = await claimAndRun(keys, crypto.randomUUID(), async () => {
          try {
            await repo.writeSlotFields(tailSlot.id, { activity_id: prevTailActivityId, is_span_head: true })
            await repo.writeSlotFields(headSlot.id, { flags: prevHeadFlags })
          } catch (err) { undoWriteError = err }
        })
        if (undoWriteError || undoOutcome.dropped) return
        setSlots(prev => {
          const next = prev.map(s => {
            if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
              return { ...s, activity_id: prevTailActivityId, is_span_head: true }
            if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
              return { ...s, flags: prevHeadFlags }
            return s
          })
          slotsRef.current = next
          return next
        })
      },
      redo: async () => {
        let redoWriteError = null
        const redoOutcome = await claimAndRun(keys, crypto.randomUUID(), async () => {
          try {
            await repo.writeSlotFields(tailSlot.id, { activity_id: headActivityId, is_span_head: false })
            await repo.writeSlotFields(headSlot.id, { flags: newFlags })
          } catch (err) { redoWriteError = err }
        })
        if (redoWriteError || redoOutcome.dropped) return
        setSlots(prev => {
          const next = prev.map(s => {
            if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
              return { ...s, activity_id: headActivityId, is_span_head: false }
            if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
              return { ...s, flags: newFlags }
            return s
          })
          slotsRef.current = next
          return next
        })
      },
    })
  }

  // T4 — split a merged span back into two independent slots
  async function splitSlot(groupId, dayId, headBlockId, gestureId) {
    if (!existingTemplates[route]) return
    const headSlot = slots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
    if (!headSlot || !headSlot.flags?.expanded) return

    const { from_block: tailBlockId } = headSlot.flags.expanded
    const tailSlot = slots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
    if (!tailSlot) return

    const cleanedFlags = { ...headSlot.flags }
    delete cleanedFlags.expanded

    setActionError(null)

    const claimId = gestureId ?? crypto.randomUUID()
    const headKey = cellKey(groupId, dayId, headBlockId)
    const tailKey = cellKey(groupId, dayId, tailBlockId)
    const keys = [headKey, tailKey].sort()

    // Fresh-read snapshot (facet 2, same mechanism as replaceSlot/expandSlot).
    const freshSlots = slotsRef.current
    const freshHeadSlot = freshSlots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId) ?? headSlot
    const freshTailSlot = freshSlots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId) ?? tailSlot
    const prevHeadFlags = freshHeadSlot.flags
    const prevTailActivityId = freshTailSlot.activity_id ?? null
    const prevTailIsSpanHead = freshTailSlot.is_span_head
    const prevTailFlags = freshTailSlot.flags ?? {}

    let writeError = null
    const outcome = await claimAndRun(keys, claimId, async () => {
      try {
        await repo.writeSlotFields(tailSlot.id, { activity_id: null, is_span_head: true, flags: {} })
        await repo.writeSlotFields(headSlot.id, { flags: cleanedFlags })
      } catch (err) {
        writeError = err
      }
    })

    if (writeError) {
      setActionError(describeWriteFailure(writeError, 'That activity could not be split back into two.'))
      return
    }
    if (outcome.dropped) return // fully superseded before dispatch: no write, no setSlots, no pushUndo

    setSlots(prev => {
      const next = prev.map(s => {
        if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
          return { ...s, activity_id: null, is_span_head: true, flags: {} }
        if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
          return { ...s, flags: cleanedFlags }
        return s
      })
      slotsRef.current = next
      return next
    })

    pushUndo({
      // T18: was `Split merged slot ${headBlockId}` — a raw uuid in a tooltip.
      description: (() => {
        const headBlock = timeBlocks.find(b => b.id === headBlockId)
        const dayLabel = days.find(d => d.id === dayId)?.label
        const where = [dayLabel, headBlock?.name].filter(Boolean).join(' ')
        return where ? `Split back into two → ${where}` : 'Split back into two'
      })(),
      undo: async () => {
        let undoWriteError = null
        const undoOutcome = await claimAndRun(keys, crypto.randomUUID(), async () => {
          try {
            await repo.writeSlotFields(tailSlot.id, { activity_id: prevTailActivityId, is_span_head: prevTailIsSpanHead ?? false, flags: prevTailFlags })
            await repo.writeSlotFields(headSlot.id, { flags: prevHeadFlags })
          } catch (err) { undoWriteError = err }
        })
        if (undoWriteError || undoOutcome.dropped) return
        setSlots(prev => {
          const next = prev.map(s => {
            if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
              return { ...s, activity_id: prevTailActivityId, is_span_head: prevTailIsSpanHead ?? false }
            if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
              return { ...s, flags: prevHeadFlags }
            return s
          })
          slotsRef.current = next
          return next
        })
      },
      redo: async () => {
        let redoWriteError = null
        const redoOutcome = await claimAndRun(keys, crypto.randomUUID(), async () => {
          try {
            await repo.writeSlotFields(tailSlot.id, { activity_id: null, is_span_head: true, flags: {} })
            await repo.writeSlotFields(headSlot.id, { flags: cleanedFlags })
          } catch (err) { redoWriteError = err }
        })
        if (redoWriteError || redoOutcome.dropped) return
        setSlots(prev => {
          const next = prev.map(s => {
            if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
              return { ...s, activity_id: null, is_span_head: true, flags: {} }
            if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
              return { ...s, flags: cleanedFlags }
            return s
          })
          slotsRef.current = next
          return next
        })
      },
    })
  }

  // Cell-created activity from the inline-write editor's "create new" path
  // (2026-08-09 spec): usage-derived rule (min_per_week starts at 1 because
  // this write IS the activity's first placement), max ∞, all-groups
  // eligible, human provenance free from repo.writeActivityFields' existing
  // default. Re-checks for a normalized-name dup defensively — CellInlineEditor
  // already resolves an exact match to onPlace, not onCreateNew, but a second
  // inline-write could race the same name between typing and Enter.
  async function createActivityFromCell(name, target) {
    const trimmed = String(name ?? '').trim()
    if (!trimmed) return

    const dupe = activities.find(a => normalizeName(a.name) === normalizeName(trimmed))
    if (dupe) {
      await placeActivityManual(dupe.id, target.groupId, target.dayId, target.blockId)
      return
    }

    const newId = crypto.randomUUID()
    const fields = {
      name: trimmed,
      camp_id: campId,
      priority: null,
      is_locked: false,
      span_blocks: 1,
      location: null,
      is_outdoor: false,
      max_groups_per_slot: 1,
      // Usage-derived: this write IS the activity's first placement, so the
      // target starts at 1 — never a spurious under-served flag on the week
      // it was hand-created for.
      min_per_week: 1,
      max_per_week: null,
      same_tier_only: false,
      eligible_tier_ids: [],
      eligible_group_ids: [],
      prefer_before_day: null,
      prefer_before_day_min: null,
      weather_alternative_id: null,
      notes: null,
    }

    setActionError(null)
    try {
      await repo.writeActivityFields(newId, fields)
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That activity could not be created.'))
      return
    }

    const newRow = { id: newId, ...fields }
    setActivities(prev => [...prev, newRow])
    await placeActivityManual(newId, target.groupId, target.dayId, target.blockId, newRow)
  }

  return {
    replaceSlot,
    dismissFlag,
    lockActivity,
    releaseCell,
    addOverlay,
    removeOverlay,
    updateOverlayRange,
    placeActivityManual,
    expandSlot,
    splitSlot,
    createActivityFromCell,
  }
}
