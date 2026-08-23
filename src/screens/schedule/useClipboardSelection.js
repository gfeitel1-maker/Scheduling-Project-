import { useState, useEffect } from 'react'

// T3 — cell selection and copy/paste. Owns the selected-cell set, the clipboard,
// and paste mode, plus the Ctrl+C (copy) / Ctrl+A (select all) / Escape keyboard
// shortcuts. Placing a pasted activity is the screen's job, so placeActivityManual
// is injected; slots/activities/selectedGroup are injected because copy and
// select-all read the week currently on screen.
//
// Transient across a route switch: reset() is called from the screen's
// transient-reset block so a selection or clipboard made on one candidate cannot
// paste into the other.
export function useClipboardSelection({ slots, activities, selectedGroup, placeActivityManual }) {
  const [selectedSlotKeys, setSelectedSlotKeys] = useState(new Set())
  const [clipboardItems, setClipboardItems] = useState([])
  const [pasteMode, setPasteMode] = useState(false)
  const [pasteModeIndex, setPasteModeIndex] = useState(0)
  const [pasteError, setPasteError] = useState(null)

  // T3 — keyboard shortcuts: Ctrl+C (copy), Ctrl+A (select all), Escape
  useEffect(() => {
    function onKeyDown(e) {
      const isMeta = e.ctrlKey || e.metaKey
      if (e.key === 'Escape') {
        if (pasteMode) {
          setPasteMode(false)
          setClipboardItems([])
          setPasteModeIndex(0)
        } else {
          setSelectedSlotKeys(new Set())
        }
        return
      }
      if (isMeta && e.key === 'c') {
        e.preventDefault()
        if (selectedSlotKeys.size === 0) return
        const items = []
        for (const key of selectedSlotKeys) {
          const [gId, dId, bId] = key.split('|')
          const s = slots.find(sl => sl.group_id === gId && sl.day_id === dId && sl.time_block_id === bId)
          if (!s || !s.activity_id) continue
          const act = activities.find(a => a.id === s.activity_id)
          items.push({ activityId: s.activity_id, activityName: act?.name || '' })
        }
        if (items.length === 0) return
        setClipboardItems(items)
        setPasteModeIndex(0)
        setPasteMode(true)
        setSelectedSlotKeys(new Set())
      }
      if (isMeta && e.key === 'a') {
        e.preventDefault()
        const newKeys = new Set()
        for (const s of slots) {
          if (s.is_anchor || !s.activity_id || s.is_span_head === false) continue
          if (selectedGroup && s.group_id !== selectedGroup) continue
          newKeys.add(`${s.group_id}|${s.day_id}|${s.time_block_id}`)
        }
        setSelectedSlotKeys(newKeys)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [pasteMode, selectedSlotKeys, slots, activities, selectedGroup])

  async function handlePasteClick(slot) {
    if (slot.is_anchor || slot.is_span_head === false) {
      setPasteError('You cannot paste onto a recurring event, or onto the second half of an activity that runs across two periods.')
      setTimeout(() => setPasteError(null), 2000)
      return
    }
    const item = clipboardItems[pasteModeIndex]
    if (!item) return
    // No drag gestureId on the paste path — synthesize a one-off claim id so
    // this write is guarded by the same per-cell queue as every other
    // mutation (2026-08-12 ADR, FIX 1; no gestureId-undefined bypass).
    await placeActivityManual(item.activityId, slot.groupId, slot.dayId, slot.blockId, undefined, crypto.randomUUID())
    const nextIndex = pasteModeIndex + 1
    if (nextIndex >= clipboardItems.length) {
      setPasteMode(false)
      setClipboardItems([])
      setPasteModeIndex(0)
    } else {
      setPasteModeIndex(nextIndex)
    }
  }

  function handleCellSelect(slot, e) {
    if (pasteMode) {
      handlePasteClick(slot)
      return
    }
    const key = `${slot.groupId}|${slot.dayId}|${slot.blockId}`
    if (e?.ctrlKey || e?.metaKey) {
      setSelectedSlotKeys(prev => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      })
    } else {
      setSelectedSlotKeys(new Set([key]))
    }
  }

  function clearSelection() {
    setSelectedSlotKeys(new Set())
  }

  function cancelPaste() {
    setPasteMode(false)
    setClipboardItems([])
    setPasteModeIndex(0)
  }

  function reset() {
    setClipboardItems([])
    setPasteMode(false)
    setPasteModeIndex(0)
    setPasteError(null)
    setSelectedSlotKeys(new Set())
  }

  return {
    selectedSlotKeys,
    clipboardItems,
    pasteMode,
    pasteModeIndex,
    pasteError,
    handleCellSelect,
    clearSelection,
    cancelPaste,
    reset,
  }
}
