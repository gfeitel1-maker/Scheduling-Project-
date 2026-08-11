import { describeWriteFailure } from '../../utils/writeErrorMessage'

// The per-cell slot / overlay mutation cluster (T32), over the T28 repository.
// Every handler follows the same shape: read the target from `slots` ->
// repo.writeSlotFields/writeOverlayFields -> setActionError on failure ->
// optimistic route setter -> pushUndo({undo, redo}) where it records one.
//
// This hook orchestrates but owns NO state: the route-scoped values and the
// route-PINNED setters come from the injected `routeState` (T31's useRouteState);
// pushUndo, the repo, editSlot/setEditSlot, setDisplacedItems, recalcStats, the
// geometry getSlot, actMap, setActivities and the data lists are injected too.
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
  editSlot,
  setEditSlot,
  setDisplacedItems,
  recalcStats,
  recalcFindings,
  getSlot,
  setActivities,
  slots,
  groups,
  activities,
  days,
  timeBlocks,
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

  async function editSlotSave(newActivityId) {
    if (!editSlot || !templateId) return
    const { groupId, dayId, blockId } = editSlot
    const slot = slots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId)
    if (!slot) return

    const prevActivityId = slot.activity_id ?? null
    const prevFlags = slot.flags ?? {}
    const nextActivityId = newActivityId || null

    setActionError(null)
    try {
      await repo.writeSlotFields(slot.id, { activity_id: nextActivityId, flags: {} })
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That cell could not be saved.'))
      return
    }
    setSlots(prev => {
      const next = prev.map(s =>
        s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId
          ? { ...s, activity_id: nextActivityId, flags: {} }
          : s
      )
      recalcStats(next)
      recalcFindings(next)
      return next
    })
    setEditSlot(null)

    const actAfter = activities.find(a => a.id === nextActivityId)
    const day = days.find(d => d.id === dayId)
    const block = timeBlocks.find(b => b.id === blockId)
    pushUndo({
      description: `Changed to ${actAfter?.name ?? 'empty'} → ${day?.label ?? ''} ${block?.name ?? ''}`.replace(/\s+/g, ' ').trim(),
      undo: async () => {
        await repo.writeSlotFields(slot.id, { activity_id: prevActivityId, flags: prevFlags })
        setSlots(prev => prev.map(s =>
          s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId
            ? { ...s, activity_id: prevActivityId, flags: prevFlags }
            : s
        ))
      },
      redo: async () => {
        await repo.writeSlotFields(slot.id, { activity_id: nextActivityId, flags: {} })
        setSlots(prev => prev.map(s =>
          s.group_id === groupId && s.day_id === dayId && s.time_block_id === blockId
            ? { ...s, activity_id: nextActivityId, flags: {} }
            : s
        ))
      },
    })
  }

  async function replaceSlot(incoming, target) {
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
    const prevTargetActivityId = targetRow.activity_id ?? null
    const prevTargetFlags = targetRow.flags ?? {}
    const prevSourceActivityId = sourceRow?.activity_id ?? null
    const prevSourceFlags = sourceRow?.flags ?? {}

    try {
      const writes = [repo.writeSlotFields(targetRow.id, { activity_id: incoming.activityId, flags: {} })]
      if (sourceRow) writes.push(repo.writeSlotFields(sourceRow.id, { activity_id: null, flags: {} }))
      await Promise.all(writes)
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That activity could not be placed.'))
      return
    }

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
        await Promise.all([
          repo.writeSlotFields(targetRow.id, { activity_id: prevTargetActivityId, flags: prevTargetFlags }),
          ...(sourceRow ? [repo.writeSlotFields(sourceRow.id, { activity_id: prevSourceActivityId, flags: prevSourceFlags })] : []),
        ])
        setSlots(prev => prev.map(s => {
          if (s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId)
            return { ...s, activity_id: prevTargetActivityId, flags: prevTargetFlags }
          if (sourceRow && s.group_id === incoming.groupId && s.day_id === incoming.dayId && s.time_block_id === incoming.blockId)
            return { ...s, activity_id: prevSourceActivityId, flags: prevSourceFlags }
          return s
        }))
      },
      redo: async () => {
        await Promise.all([
          repo.writeSlotFields(targetRow.id, { activity_id: incoming.activityId, flags: {} }),
          ...(sourceRow ? [repo.writeSlotFields(sourceRow.id, { activity_id: null, flags: {} })] : []),
        ])
        setSlots(prev => prev.map(s => {
          if (s.group_id === target.groupId && s.day_id === target.dayId && s.time_block_id === target.blockId)
            return { ...s, activity_id: incoming.activityId, flags: {} }
          if (sourceRow && s.group_id === incoming.groupId && s.day_id === incoming.dayId && s.time_block_id === incoming.blockId)
            return { ...s, activity_id: null, flags: {} }
          return s
        }))
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

  async function placeActivityManual(activityId, groupId, dayId, blockId) {
    if (!existingTemplates[route]) return
    const slot = getSlot(slots, groupId, dayId, blockId)
    if (!slot || slot.is_anchor) return

    const activity = activities.find(a => a.id === activityId)
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

  async function expandSlot(groupId, dayId, headBlockId, tailBlockId, tailActivityId, tailActivityName, tailBlockName, dayLabel) {
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
    try {
      // Update tail slot: now owned by head activity, marked as tail (is_span_head = false)
      await repo.writeSlotFields(tailSlot.id, { activity_id: headActivityId, is_span_head: false })

      // Write flag to head slot
      await repo.writeSlotFields(headSlot.id, { flags: newFlags })
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That activity could not be made longer.'))
      return
    }

    // Update local state
    setSlots(prev => prev.map(s => {
      if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId) {
        return { ...s, activity_id: headActivityId, is_span_head: false }
      }
      if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId) {
        return { ...s, flags: newFlags }
      }
      return s
    }))

    // Add displaced activity to palette
    if (tailActivityId) {
      setDisplacedItems(prev => [
        ...prev,
        {
          activityId: tailActivityId,
          activityName: tailActivityName,
          fromBlockName: tailBlockName,
          dayLabel,
        },
      ])
    }

    const prevHeadFlags = headSlot.flags ?? {}
    const prevTailActivityId = tailSlot.activity_id ?? null
    pushUndo({
      description: `Made ${headActivityId ? actMap.get(headActivityId)?.name ?? 'an activity' : 'an activity'} run longer → ${tailBlockName} ${dayLabel}`,
      undo: async () => {
        await repo.writeSlotFields(tailSlot.id, { activity_id: prevTailActivityId, is_span_head: true })
        await repo.writeSlotFields(headSlot.id, { flags: prevHeadFlags })
        setSlots(prev => prev.map(s => {
          if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
            return { ...s, activity_id: prevTailActivityId, is_span_head: true }
          if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
            return { ...s, flags: prevHeadFlags }
          return s
        }))
        if (tailActivityId) setDisplacedItems(prev => prev.filter(i => !(i.activityId === tailActivityId && i.fromBlockName === tailBlockName)))
      },
      redo: async () => {
        await repo.writeSlotFields(tailSlot.id, { activity_id: headActivityId, is_span_head: false })
        await repo.writeSlotFields(headSlot.id, { flags: newFlags })
        setSlots(prev => prev.map(s => {
          if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
            return { ...s, activity_id: headActivityId, is_span_head: false }
          if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
            return { ...s, flags: newFlags }
          return s
        }))
        if (tailActivityId) {
          setDisplacedItems(prev => [...prev, { activityId: tailActivityId, activityName: tailActivityName, fromBlockName: tailBlockName, dayLabel }])
        }
      },
    })
  }

  // T4 — split a merged span back into two independent slots
  async function splitSlot(groupId, dayId, headBlockId) {
    if (!existingTemplates[route]) return
    const headSlot = slots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
    if (!headSlot || !headSlot.flags?.expanded) return

    const { displacedActivityId, displacedActivityName, from_block: tailBlockId } = headSlot.flags.expanded
    const tailSlot = slots.find(s => s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
    if (!tailSlot) return

    const cleanedFlags = { ...headSlot.flags }
    delete cleanedFlags.expanded

    setActionError(null)
    try {
      await repo.writeSlotFields(tailSlot.id, { activity_id: null, is_span_head: true, flags: {} })
      await repo.writeSlotFields(headSlot.id, { flags: cleanedFlags })
    } catch (err) {
      setActionError(describeWriteFailure(err, 'That activity could not be split back into two.'))
      return
    }

    setSlots(prev => prev.map(s => {
      if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
        return { ...s, activity_id: null, is_span_head: true, flags: {} }
      if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
        return { ...s, flags: cleanedFlags }
      return s
    }))

    const prevHeadFlags = headSlot.flags
    const prevTailActivityId = tailSlot.activity_id ?? null
    const prevTailIsSpanHead = tailSlot.is_span_head

    if (displacedActivityId && displacedActivityName) {
      const tailBlock = timeBlocks.find(b => b.id === tailBlockId)
      const day = days.find(d => d.id === dayId)
      setDisplacedItems(prev => [
        ...prev,
        {
          activityId: displacedActivityId,
          activityName: displacedActivityName,
          fromBlockName: tailBlock?.name ?? '',
          dayLabel: day?.label ?? '',
        },
      ])
    }

    pushUndo({
      // T18: was `Split merged slot ${headBlockId}` — a raw uuid in a tooltip.
      description: (() => {
        const headBlock = timeBlocks.find(b => b.id === headBlockId)
        const dayLabel = days.find(d => d.id === dayId)?.label
        const where = [dayLabel, headBlock?.name].filter(Boolean).join(' ')
        return where ? `Split back into two → ${where}` : 'Split back into two'
      })(),
      undo: async () => {
        await repo.writeSlotFields(tailSlot.id, { activity_id: prevTailActivityId, is_span_head: prevTailIsSpanHead ?? false, flags: tailSlot.flags ?? {} })
        await repo.writeSlotFields(headSlot.id, { flags: prevHeadFlags })
        setSlots(prev => prev.map(s => {
          if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
            return { ...s, activity_id: prevTailActivityId, is_span_head: prevTailIsSpanHead ?? false }
          if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
            return { ...s, flags: prevHeadFlags }
          return s
        }))
        if (displacedActivityId) {
          const tailBlock = timeBlocks.find(b => b.id === tailBlockId)
          setDisplacedItems(prev => prev.filter(i => !(i.activityId === displacedActivityId && i.fromBlockName === (tailBlock?.name ?? ''))))
        }
      },
      redo: async () => {
        await repo.writeSlotFields(tailSlot.id, { activity_id: null, is_span_head: true, flags: {} })
        await repo.writeSlotFields(headSlot.id, { flags: cleanedFlags })
        setSlots(prev => prev.map(s => {
          if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === tailBlockId)
            return { ...s, activity_id: null, is_span_head: true, flags: {} }
          if (s.group_id === groupId && s.day_id === dayId && s.time_block_id === headBlockId)
            return { ...s, flags: cleanedFlags }
          return s
        }))
      },
    })
  }

  return {
    editSlotSave,
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
  }
}
