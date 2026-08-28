import { useEffect, useState } from 'react'
import { localClient } from '../localClient'

// ADR docs/adr/2026-08-28-roots-home-is-a-distinct-screen.md §4 — Candidate
// C2: its own read hook, not a reuse of ReconciliationScreen's
// fetchReadiness/readinessCollectionsFromCensus (those carry census/mode
// assumptions this screen doesn't have). Calls localClient.list() per
// entity itself, mirroring fetchReadiness's pattern rather than importing it.
// Refetches on every mount (Candidate C1/C4) — no cross-render cache.
const STRUCTURE_ENTITIES = [
  'tiers', 'groups', 'days_of_operation', 'time_blocks', 'locations', 'activities', 'anchor_activities',
]

export function useCurrentStructureCounts(campId) {
  const [collections, setCollections] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      const next = {}
      for (const entity of STRUCTURE_ENTITIES) {
        next[entity] = await localClient.list(entity).catch(() => [])
      }
      if (cancelled) return
      setCollections(next)
      setLoading(false)
    }
    load().catch((err) => {
      if (cancelled) return
      setError(err)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [campId])

  return { collections, loading, error }
}
