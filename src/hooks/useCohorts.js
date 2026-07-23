import { useState, useEffect } from 'react'
import { localClient } from '../localClient'

// Loads cohorts for a camp and tracks which one is active.
// activeCohort defaults to cohorts[0] (lowest sort_order).
// Screens that need cohort-scoped data call this hook and use activeCohort.id.
export function useCohorts(campId) {
  const [cohorts, setCohorts] = useState([])
  const [activeCohortId, setActiveCohortId] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!campId) return
    load()
  }, [campId])

  async function load() {
    setLoading(true)
    let list = []
    try {
      const data = await localClient.list('cohorts')
      list = (data || [])
        .filter((c) => c.camp_id === campId)
        .sort((a, b) => {
          // LOW (deferred per Sub-plan B Task 2 round 1 Red Hat review,
          // revisit in Task 3): null sort_order tie-break coerces to 0,
          // which can interleave unpredictably with real sort_order: 0 rows.
          const sortDiff = (a.sort_order ?? 0) - (b.sort_order ?? 0)
          if (sortDiff !== 0) return sortDiff
          return (a.name ?? '').localeCompare(b.name ?? '')
        })
    } catch {
      list = []
    }
    setCohorts(list)
    setActiveCohortId(prev => {
      // Keep selection if previously selected cohort still exists
      if (prev && list.some(c => c.id === prev)) return prev
      return list[0]?.id ?? null
    })
    setLoading(false)
  }

  const activeCohort = cohorts.find(c => c.id === activeCohortId) ?? cohorts[0] ?? null

  return { cohorts, activeCohort, setActiveCohortId, loading, reload: load }
}
