import { useCallback, useEffect, useState } from 'react'
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

// A stable identity for "nothing failed", so a consumer may depend on `failed`
// without every render handing it a fresh Set.
const NO_FAILURES = new Set()

// T304 — WHY THE FAILURE IS RETURNED ALONGSIDE THE ARRAY RATHER THAN INSTEAD OF IT.
//
// This read used to be `localClient.list(entity).catch(() => [])`, which turned
// every failure into an empty array — indistinguishable from "this camp
// genuinely has none of these". The Roots home then rendered "Nothing needs you
// right now." for a camp with work waiting, and a bento card rendered a
// confident `0` for a collection it had not read. That is the silent-failure
// class this repo keeps writing rules against.
//
// The empty array STAYS, because a consumer that iterates a collection needs
// something iterable and one unreadable entity must not take the screen down.
// What is added is a separate, explicit report of what could not be read, so a
// consumer that means to be honest has something to be honest WITH. Callers that
// present a count or an all-clear MUST consult it; RootsHomeScreen does, on both
// the bento and the attention rail.
//
// It reports the failure whatever the cause. The one that opened T304 was an
// authorization denial — a staff session's `campers` read threw 'admin role
// required', and `forbidden` is the ONE deny reason absent from main.js's
// SESSION_INVALID_REASONS, so it pushes no shoresh:auth-rejected event either.
// This `catch` was the only thing in the process that saw it. A db error, a
// revoked device and an expired session all arrive the same way.
export function useCurrentStructureCounts(campId) {
  const [collections, setCollections] = useState(null)
  const [failed, setFailed] = useState(NO_FAILURES)
  const [loading, setLoading] = useState(true)
  // T306 — a WRITE MADE ON THIS DEVICE does not cross the sync channel, so naming
  // an unattributed camper left its own attention row on screen: the director acted,
  // the row stayed, and the action read as a failure. This effect keyed on [campId]
  // alone, which never changes while the Roots home is open.
  const [reloadNonce, setReloadNonce] = useState(0)
  const reload = useCallback(() => setReloadNonce((n) => n + 1), [])

  useEffect(() => {
    let cancelled = false
    async function load() {
      const next = {}
      const couldNotRead = new Set()
      for (const entity of STRUCTURE_ENTITIES) {
        try {
          next[entity] = await localClient.list(entity)
        } catch {
          next[entity] = []
          couldNotRead.add(entity)
        }
      }
      if (cancelled) return
      setCollections(next)
      setFailed(couldNotRead.size === 0 ? NO_FAILURES : couldNotRead)
      setLoading(false)
    }
    load()
    return () => { cancelled = true }
  }, [campId, reloadNonce])

  return { collections, failed, loading, reload }
}
