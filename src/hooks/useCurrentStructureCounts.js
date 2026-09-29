import { useEffect, useState } from 'react'
import { localClient } from '../localClient'

// ADR docs/adr/2026-08-28-roots-home-is-a-distinct-screen.md §4 — Candidate
// C2: its own read hook, not a reuse of ReconciliationScreen's
// fetchReadiness/readinessCollectionsFromCensus (those carry census/mode
// assumptions this screen doesn't have). Calls localClient.list() per
// entity itself, mirroring fetchReadiness's pattern rather than importing it.
// Refetches on every mount (Candidate C1/C4) — no cross-render cache.
// EXPORTED so the contract with buildStructureIssues can be asserted rather than
// assumed. It is not a display list: `campers` feeds no card and no chip row, and
// was missing here while buildStructureIssues read it — which made every check over
// campers dead in the product while passing its own unit tests, because those tests
// hand it a collections object this hook never produces (T299).
export const STRUCTURE_ENTITIES = [
  'tiers', 'groups', 'days_of_operation', 'time_blocks', 'locations', 'activities', 'fixed_events',
  // T285's unattributed subjects live on the attention surface (owner ruling), and
  // T299's "these two sheets answered identically" rides on the same rows.
  'campers',
]

export function useCurrentStructureCounts(campId) {
  const [collections, setCollections] = useState(null)
  const [loading, setLoading] = useState(true)

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
    load()
    return () => { cancelled = true }
  }, [campId])

  return { collections, loading }
}
