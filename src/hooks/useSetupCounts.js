import { useState, useEffect, useCallback } from 'react'
import { localClient } from '../localClient'
import { AREA_TABLE } from '../components/layout/navSections'
import { loadSidebarState, shouldOfferFold } from '../components/layout/sidebarState'
import { getSetupGaps } from '../engine/readiness'

function countGaps(counts) {
  return getSetupGaps({
    cohorts: Array(counts.cohorts || 0),
    tiers: Array(counts.tiers || 0),
    groups: Array(counts.groups || 0),
    days: Array(counts.days || 0),
    timeBlocks: Array(counts.timeblocks || 0),
    activities: Array(counts.activities || 0),
  })
}

export function useSetupCounts(campId) {
  const [campName, setCampName] = useState('')
  const [projectPath, setProjectPath] = useState(null)
  const [isDevDb, setIsDevDb] = useState(false)
  const [buildLabel, setBuildLabel] = useState(null)
  const [backupStatus, setBackupStatus] = useState(null)
  const [counts, setCounts] = useState(null)
  const [syncStatus, setSyncStatus] = useState(null)
  const [offerShown, setOfferShown] = useState(false)

  const refreshCounts = useCallback(async () => {
    const areas = Object.keys(AREA_TABLE)
    // An AREA_TABLE entry is a table name, or { table, kind } when two nav rows
    // read the same table and must not report each other's rows (T124).
    const specFor = (area) => {
      const entry = AREA_TABLE[area]
      return typeof entry === 'string' ? { table: entry, kind: null } : entry
    }
    const results = await Promise.all(
      areas.map((area) => localClient.list(specFor(area).table).catch(() => []))
    )
    const next = {}
    areas.forEach((area, i) => {
      const { kind } = specFor(area)
      const rows = Array.isArray(results[i]) ? results[i] : []
      next[area] = rows.filter((r) =>
        (!campId || !r.camp_id || r.camp_id === campId) && (!kind || r.kind === kind)
      ).length
    })

    setCounts((prev) => {
      if (prev !== null && shouldOfferFold({
        gaps: countGaps(next),
        previousGaps: countGaps(prev),
        alreadyOffered: loadSidebarState(globalThis.localStorage).offered,
      })) {
        setOfferShown(true)
      }
      return next
    })
  }, [campId])

  useEffect(() => {
    void (async () => { await refreshCounts() })()
  }, [refreshCounts])

  useEffect(() => {
    let cancelled = false
    localClient.getSyncStatus?.()
      .then((s) => { if (!cancelled) setSyncStatus(s) })
      .catch(() => {})
    const unsub = localClient.onSyncStatusChanged?.((s) => setSyncStatus(s))
    return () => { cancelled = true; unsub?.() }
  }, [])

  // Two channels, because a count can change for two different reasons.
  // onOpApplied is an op arriving from ANOTHER device; onLocalWrite is this
  // director's own write. Only the first was subscribed here, which is why
  // importing a season left the sidebar reading "! Groups needed" beside a
  // Roots panel reading "Groups 33" until the app was reloaded (T123).
  useEffect(() => {
    const unsubs = [
      localClient.onOpApplied?.(() => { refreshCounts() }),
      localClient.onLocalWrite?.(() => { refreshCounts() }),
    ]
    return () => { for (const unsub of unsubs) unsub?.() }
  }, [refreshCounts])

  useEffect(() => {
    if (!campId) return
    localClient.getCamp()
      .then((data) => { if (data) setCampName(data.name) })
      .catch(() => {})
  }, [campId])

  useEffect(() => {
    if (typeof localClient.getCurrentProject !== 'function') return
    localClient.getCurrentProject()
      .then((info) => {
        if (info?.path) setProjectPath(info.path)
        if (info) { setIsDevDb(!!info.isDev); setBuildLabel(info.build || null) }
      })
      .catch(() => {})
  }, [campId])

  const handleBackupNow = useCallback(async () => {
    setBackupStatus('running')
    try {
      const result = await localClient.backupProject()
      setBackupStatus(result?.error ? 'error' : 'ok')
    } catch {
      setBackupStatus('error')
    }
    setTimeout(() => setBackupStatus(null), 3000)
  }, [])

  return {
    counts,
    campName,
    syncStatus,
    projectPath,
    isDevDb,
    buildLabel,
    backupStatus,
    handleBackupNow,
    offerShown,
    setOfferShown,
  }
}
