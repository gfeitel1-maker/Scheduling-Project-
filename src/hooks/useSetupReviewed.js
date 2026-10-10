import { useState, useEffect } from 'react'
import { PREFILLED_AREAS, loadSetupReviewed, markAreaReviewed, settleSetupReviewed } from '../utils/setupReviewed'

// `currentArea` is the area whose screen is open now; opening a pre-filled
// step's screen is what marks it reviewed.
export function useSetupReviewed(campId, counts, currentArea) {
  const [areas, setAreas] = useState(() => (campId ? loadSetupReviewed(globalThis.localStorage, campId).areas : {}))

  useEffect(() => {
    if (!campId) return
    const storage = globalThis.localStorage
    let state = loadSetupReviewed(storage, campId)
    if (counts && !state.decided) state = settleSetupReviewed(storage, campId, counts)
    if (PREFILLED_AREAS.includes(currentArea) && !state.areas[currentArea]) state = markAreaReviewed(storage, campId, currentArea)
    setAreas(state.areas)
  }, [campId, counts, currentArea])

  return areas
}
