import { useState, useEffect } from 'react'

// Overlay fill / stamp cluster. Owns the transient direct-manipulation state:
// the in-progress fill drag (fillState) and the active field-trip stamp
// (stampMode).
//
// It orchestrates persistence through the screen's overlay handlers rather than
// re-implementing them: handleStampClick calls addOverlay, and the fill drag
// commits through updateOverlayRange on pointer-up. groups/timeBlocks/overlays
// are injected because those reads describe the week on screen.
//
// setStampMode is exposed raw: the screen's own toolbar (Field Trip drawer)
// drives stampMode. fillState stays readable so the screen can feed it into
// makeGridGeometry (the grid draws the live fill preview from it).
//
// Transient across a route switch: reset() is called from the screen's
// transient-reset block.
export function useOverlayFillStamp({ groups, timeBlocks, overlays, addOverlay, updateOverlayRange }) {
  const [stampMode, setStampMode] = useState(null) // null | string (label of active stamp)
  const [fillState, setFillState] = useState(null)  // null | { overlayId, previewToOrder }

  useEffect(() => {
    if (!fillState) return
    function onPointerUp() {
      const previewTo = fillState.previewToOrder
      if (previewTo !== undefined) {
        const overlay = overlays.find(o => o.id === fillState.overlayId)
        if (overlay && previewTo !== overlay.to_block_order) {
          updateOverlayRange(fillState.overlayId, previewTo)
        }
      }
      setFillState(null)
    }
    window.addEventListener('pointerup', onPointerUp)
    return () => window.removeEventListener('pointerup', onPointerUp)
  // updateOverlayRange is redefined every render now that `overlays` is a
  // derived, route-scoped value; listing it would re-bind the listener on
  // every render for no behavioural gain. The values it reads are in the deps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fillState, overlays])

  async function handleStampClick(groupId, dayId, blockId) {
    if (!stampMode) return
    const group = groups.find(g => g.id === groupId)
    const block = timeBlocks.find(b => b.id === blockId)
    if (!group || !block) return
    await addOverlay({
      unitId: group.tier_id,
      dayId,
      fromBlockOrder: block.sort_order,
      toBlockOrder: block.sort_order,
      label: stampMode,
    })
  }

  function startFill(overlay) {
    setFillState({ overlayId: overlay.id, previewToOrder: overlay.to_block_order })
  }

  function handleFillEnter(blockSortOrder) {
    if (!fillState) return
    const overlay = overlays.find(o => o.id === fillState.overlayId)
    if (!overlay) return
    if (blockSortOrder >= overlay.from_block_order) {
      setFillState(prev => ({ ...prev, previewToOrder: blockSortOrder }))
    }
  }

  function reset() {
    setStampMode(null)
    setFillState(null)
  }

  return {
    fillState,
    stampMode,
    setStampMode,
    startFill,
    handleFillEnter,
    handleStampClick,
    reset,
  }
}
