import { useState, useEffect } from 'react'
import { supabase } from '../supabase'

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
    const { data } = await supabase
      .from('cohorts')
      .select('*')
      .eq('camp_id', campId)
      .order('sort_order')
      .order('name')
    const list = data || []
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
