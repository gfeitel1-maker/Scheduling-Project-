import { useMemo } from 'react'
import { PREFILLED_AREAS, loadSetupReviewed, markAreaReviewed, settleSetupReviewed } from '../utils/setupReviewed'

// `currentArea` is the area whose screen is open now; opening a pre-filled
// step's screen is what marks it reviewed.
//
// `countsFor` ({ campId, complete }, from useSetupCounts) gates the one-time
// "was this camp already in use?" decision: it is made only from counts read
// for THIS camp with every list read succeeding, because a failed read counts
// as 0 and would settle an in-use camp as new, permanently.
//
// Returns { areas, decided }. Until the camp is decided the caller shows no
// "needs a look" mark, so an upgrading in-use camp never flashes one.
//
// Derived during render (the storage writes are idempotent), with this
// session's own marks also kept in memory so a blocked storage still holds a
// tick until the app closes.
const sessionMarks = new Map()

export function resetSetupReviewedSessionForTests() {
  sessionMarks.clear()
}

export function useSetupReviewed(campId, counts, currentArea, countsFor) {
  return useMemo(() => {
    if (!campId) return { decided: false, areas: {} }
    const storage = globalThis.localStorage
    const remembered = sessionMarks.get(campId) ?? { decided: false, areas: {} }
    const loaded = loadSetupReviewed(storage, campId)
    let next = { decided: loaded.decided || remembered.decided, areas: { ...remembered.areas, ...loaded.areas } }
    const countsUsable = counts && countsFor?.campId === campId && countsFor.complete
    if (countsUsable && !next.decided) {
      const settled = settleSetupReviewed(storage, campId, counts)
      next = { decided: true, areas: { ...next.areas, ...settled.areas } }
    }
    if (PREFILLED_AREAS.includes(currentArea) && !next.areas[currentArea]) {
      markAreaReviewed(storage, campId, currentArea)
      next = { ...next, areas: { ...next.areas, [currentArea]: true } }
    }
    sessionMarks.set(campId, next)
    return next
  }, [campId, counts, countsFor, currentArea])
}
