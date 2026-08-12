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

  // Per-cell gesture-recency ledger (2026-08-12 write-serialization ADR).
  // key: `${groupId}|${dayId}|${blockId}` -> the gestureId that last CLAIMED
  // that cell. A "claim" is a synchronous `.set()` made right before a write
  // is issued (before any `await`), so the ledger always reflects "the last
  // gesture that STARTED touching this cell" -- not which write finishes
  // first. A write that resolves later checks its claim is still current
  // before applying `setSlots`; a superseded write is dropped silently (the
  // newer gesture already committed the cell to what the director actually
  // chose -- nothing failed).
  //
  // gestureId === undefined is the "no concurrent gesture" case (any
  // non-drag caller, e.g. the click-driven "merge down"/"split" handlers) --
  // such a call always claims and always reads back current, by design: a
  // single click-driven mutation has nothing of its own to race against, and
  // making every call site synthesize an id would be needless plumbing for
  // paths that provably cannot race with themselves.
  const cellGestureRef = useRef(new Map())

  function cellKey(groupId, dayId, blockId) {
    return `${groupId}|${dayId}|${blockId}`
  }
  function claimCell(key, gestureId) {
    cellGestureRef.current.set(key, gestureId)
  }
  function cellIsCurrent(key, gestureId) {
    return gestureId === undefined || cellGestureRef.current.get(key) === gestureId
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

    const targetKey = cellKey(target.groupId, target.dayId, target.blockId)
    const sourceKey = sourceRow ? cellKey(incoming.groupId, incoming.dayId, incoming.blockId) : null
    // Claim BEFORE issuing the write(s) — synchronous, before any `await` — so a
    // second same-cell call arriving before this one's write resolves overwrites
    // the claim immediately, and the ledger always reflects the last gesture
    // that STARTED touching this cell.
    claimCell(targetKey, gestureId)
    if (sourceKey) claimCell(sourceKey, gestureId)

    const freshSlots = slotsRef.current
    const freshTargetRow = freshSlots.find(s => s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId) ?? targetRow
    const freshSourceRow = sourceRow
      ? (freshSlots.find(s => s.group_id === incoming.groupId && s.day_id === incoming.dayId && s.time_block_id === incoming.blockId) ?? sourceRow)
      : null
    const prevTargetActivityId = freshTargetRow.activity_id ?? null
    const prevTargetFlags = freshTargetRow.flags ?? {}
    const prevSourceActivityId = freshSourceRow?.activity_id ?? null
    const prevSourceFlags = freshSourceRow?.flags ?? {}

    try {
      const writes = [repo.writeSlotFields(targetRow.id, { activity_id: incoming.activityId, flags: {} })]
      if (sourceRow) writes.push(repo.writeSlotFields(sourceRow.id, { activity_id: null, flags: {} }))
      await Promise.all(writes)
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That activity could not be placed.'))
      return
    }

    // Recency check: only apply the slice of this write whose cell is still
    // claimed by THIS gestureId. A cell a newer gesture has since claimed is
    // left untouched here — that newer gesture's own call owns it.
    const targetCurrent = cellIsCurrent(targetKey, gestureId)
    const sourceCurrent = sourceKey ? cellIsCurrent(sourceKey, gestureId) : false
    if (!targetCurrent && !sourceCurrent) return // fully superseded: no setSlots, no pushUndo

    setSlots(prev => {
      const next = prev.map(s => {
        if (targetCurrent && s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId)
          return { ...s, activity_id: incoming.activityId, flags: {} }
        if (sourceRow && sourceCurrent && s.group_id === incoming.groupId && s.day_id === incoming.dayId && s.time_block_id === incoming.blockId)
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
        // Re-claim for this entry's own gestureId immediately before writing,
        // exactly like the forward path — an undo run after a newer gesture
        // has since touched the cell must not silently stomp it.
        claimCell(targetKey, gestureId)
        if (sourceKey) claimCell(sourceKey, gestureId)
        await Promise.all([
          repo.writeSlotFields(targetRow.id, { activity_id: prevTargetActivityId, flags: prevTargetFlags }),
          ...(sourceRow ? [repo.writeSlotFields(sourceRow.id, { activity_id: prevSourceActivityId, flags: prevSourceFlags })] : []),
        ])
        const tCurrent = cellIsCurrent(targetKey, gestureId)
        const sCurrent = sourceKey ? cellIsCurrent(sourceKey, gestureId) : false
        if (!tCurrent && !sCurrent) return
        setSlots(prev => {
          const next = prev.map(s => {
            if (tCurrent && s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId)
              return { ...s, activity_id: prevTargetActivityId, flags: prevTargetFlags }
            if (sourceRow && sCurrent && s.group_id === incoming.groupId && s.day_id === incoming.dayId && s.time_block_id === incoming.blockId)
              return { ...s, activity_id: prevSourceActivityId, flags: prevSourceFlags }
            return s
          })
          slotsRef.current = next
          return next
        })
      },
      redo: async () => {
        claimCell(targetKey, gestureId)
        if (sourceKey) claimCell(sourceKey, gestureId)
        await Promise.all([
          repo.writeSlotFields(targetRow.id, { activity_id: incoming.activityId, flags: {} }),
          ...(sourceRow ? [repo.writeSlotFields(sourceRow.id, { activity_id: null, flags: {} })] : []),
        ])
        const tCurrent = cellIsCurrent(targetKey, gestureId)
        const sCurrent = sourceKey ? cellIsCurrent(sourceKey, gestureId) : false
        if (!tCurrent && !sCurrent) return
        setSlots(prev => {
          const next = prev.map(s => {
            if (tCurrent && s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId)
              return { ...s, activity_id: incoming.activityId, flags: {} }
            if (sourceRow && sCurrent && s.group_id === incoming.groupId && s.day_id === incoming.dayId && s.time_block_id === incoming.blockId)
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
  async function placeActivityManual(activityId, groupId, dayId, blockId, activityOverride) {
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

    const prevActivityId = slot.activity_id ?? null
    const prevFlags = slot.flags ?? {}

    setActionError(null)
    try {
      await repo.writeSlotFields(slot.id, { activity_id: activityId, flags })
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That activity could not be placed.'))
      return
    }

    setSlots(prev => {
      const next = prev.map(s =>
        s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId
          ? { ...s, activity_id: activityId, flags }
          : s
      )
      recalcStats(next)
      recalcFindings(next)
      return next
    })

    const day = days.find(d => d.id === dayId)
    const block = timeBlocks.find(b => b.id === blockId)
    pushUndo({
      description: `Placed ${activity.name} → ${group?.name ?? groupId} ${day?.label ?? dayId} ${block?.name ?? blockId}`,
      undo: async () => {
        await repo.writeSlotFields(slot.id, { activity_id: prevActivityId, flags: prevFlags })
        setSlots(prev => prev.map(s =>
          s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId
            ? { ...s, activity_id: prevActivityId, flags: prevFlags }
            : s
        ))
      },
      redo: async () => {
        await repo.writeSlotFields(slot.id, { activity_id: activityId, flags })
        setSlots(prev => prev.map(s =>
          s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId
            ? { ...s, activity_id: activityId, flags }
            : s
        ))
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

    const headKey = cellKey(groupId, dayId, headBlockId)
    const tailKey = cellKey(groupId, dayId, tailBlockId)
    claimCell(headKey, gestureId)
    claimCell(tailKey, gestureId)

    // Fresh-read snapshot (facet 2, same mechanism as replaceSlot's fix): read
    // the undo-relevant "previous" values off slotsRef, not the `slots` prop
    // this call closed over, so a second racing expand/split on the same head
    // cell can't compute an identical, stale "previous" value.
    const freshSlots = slotsRef.current
    const freshHeadSlot = freshSlots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId) ?? headSlot
    const freshTailSlot = freshSlots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId) ?? tailSlot
    const prevHeadFlags = freshHeadSlot.flags ?? {}
    const prevTailActivityId = freshTailSlot.activity_id ?? null

    try {
      // Update tail slot: now owned by head activity, marked as tail (is_span_head = false)
      await repo.writeSlotFields(tailSlot.id, { activity_id: headActivityId, is_span_head: false })

      // Write flag to head slot
      await repo.writeSlotFields(headSlot.id, { flags: newFlags })
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That activity could not be made longer.'))
      return
    }

    const headCurrent = cellIsCurrent(headKey, gestureId)
    const tailCurrent = cellIsCurrent(tailKey, gestureId)
    if (!headCurrent && !tailCurrent) return // fully superseded: no setSlots, no pushUndo

    // Update local state
    setSlots(prev => {
      const next = prev.map(s => {
        if (tailCurrent && s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId) {
          return { ...s, activity_id: headActivityId, is_span_head: false }
        }
        if (headCurrent && s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId) {
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
        claimCell(headKey, gestureId)
        claimCell(tailKey, gestureId)
        await repo.writeSlotFields(tailSlot.id, { activity_id: prevTailActivityId, is_span_head: true })
        await repo.writeSlotFields(headSlot.id, { flags: prevHeadFlags })
        const hCurrent = cellIsCurrent(headKey, gestureId)
        const tCurrent = cellIsCurrent(tailKey, gestureId)
        if (!hCurrent && !tCurrent) return
        setSlots(prev => {
          const next = prev.map(s => {
            if (tCurrent && s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
              return { ...s, activity_id: prevTailActivityId, is_span_head: true }
            if (hCurrent && s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
              return { ...s, flags: prevHeadFlags }
            return s
          })
          slotsRef.current = next
          return next
        })
      },
      redo: async () => {
        claimCell(headKey, gestureId)
        claimCell(tailKey, gestureId)
        await repo.writeSlotFields(tailSlot.id, { activity_id: headActivityId, is_span_head: false })
        await repo.writeSlotFields(headSlot.id, { flags: newFlags })
        const hCurrent = cellIsCurrent(headKey, gestureId)
        const tCurrent = cellIsCurrent(tailKey, gestureId)
        if (!hCurrent && !tCurrent) return
        setSlots(prev => {
          const next = prev.map(s => {
            if (tCurrent && s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
              return { ...s, activity_id: headActivityId, is_span_head: false }
            if (hCurrent && s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
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

    const headKey = cellKey(groupId, dayId, headBlockId)
    const tailKey = cellKey(groupId, dayId, tailBlockId)
    claimCell(headKey, gestureId)
    claimCell(tailKey, gestureId)

    // Fresh-read snapshot (facet 2, same mechanism as replaceSlot/expandSlot).
    const freshSlots = slotsRef.current
    const freshHeadSlot = freshSlots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId) ?? headSlot
    const freshTailSlot = freshSlots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId) ?? tailSlot
    const prevHeadFlags = freshHeadSlot.flags
    const prevTailActivityId = freshTailSlot.activity_id ?? null
    const prevTailIsSpanHead = freshTailSlot.is_span_head
    const prevTailFlags = freshTailSlot.flags ?? {}

    try {
      await repo.writeSlotFields(tailSlot.id, { activity_id: null, is_span_head: true, flags: {} })
      await repo.writeSlotFields(headSlot.id, { flags: cleanedFlags })
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That activity could not be split back into two.'))
      return
    }

    const headCurrent = cellIsCurrent(headKey, gestureId)
    const tailCurrent = cellIsCurrent(tailKey, gestureId)
    if (!headCurrent && !tailCurrent) return // fully superseded: no setSlots, no pushUndo

    setSlots(prev => {
      const next = prev.map(s => {
        if (tailCurrent && s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
          return { ...s, activity_id: null, is_span_head: true, flags: {} }
        if (headCurrent && s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
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
        claimCell(headKey, gestureId)
        claimCell(tailKey, gestureId)
        await repo.writeSlotFields(tailSlot.id, { activity_id: prevTailActivityId, is_span_head: prevTailIsSpanHead ?? false, flags: prevTailFlags })
        await repo.writeSlotFields(headSlot.id, { flags: prevHeadFlags })
        const hCurrent = cellIsCurrent(headKey, gestureId)
        const tCurrent = cellIsCurrent(tailKey, gestureId)
        if (!hCurrent && !tCurrent) return
        setSlots(prev => {
          const next = prev.map(s => {
            if (tCurrent && s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
              return { ...s, activity_id: prevTailActivityId, is_span_head: prevTailIsSpanHead ?? false }
            if (hCurrent && s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
              return { ...s, flags: prevHeadFlags }
            return s
          })
          slotsRef.current = next
          return next
        })
      },
      redo: async () => {
        claimCell(headKey, gestureId)
        claimCell(tailKey, gestureId)
        await repo.writeSlotFields(tailSlot.id, { activity_id: null, is_span_head: true, flags: {} })
        await repo.writeSlotFields(headSlot.id, { flags: cleanedFlags })
        const hCurrent = cellIsCurrent(headKey, gestureId)
        const tCurrent = cellIsCurrent(tailKey, gestureId)
        if (!hCurrent && !tCurrent) return
        setSlots(prev => {
          const next = prev.map(s => {
            if (tCurrent && s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
              return { ...s, activity_id: null, is_span_head: true, flags: {} }
            if (hCurrent && s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
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
