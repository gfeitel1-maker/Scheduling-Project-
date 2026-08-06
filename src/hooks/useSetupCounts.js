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
  const [startedRoutes, setStartedRoutes] = useState(0)
  const [syncStatus, setSyncStatus] = useState(null)
  const [offerShown, setOfferShown] = useState(false)

  const refreshCounts = useCallback(async () => {
    const areas = Object.keys(AREA_TABLE)
    const results = await Promise.all(
      areas.map((area) => localClient.list(AREA_TABLE[area]).catch(() => []))
    )
    const next = {}
    areas.forEach((area, i) => {
      const rows = Array.isArray(results[i]) ? results[i] : []
      next[area] = campId ? rows.filter((r) => !r.camp_id || r.camp_id === campId).length : rows.length
    })

    const slots = await localClient.list('template_slots').catch(() => [])
    setStartedRoutes(new Set((Array.isArray(slots) ? slots : []).map((r) => r.template_id)).size)

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

  useEffect(() => {
    if (typeof localClient.onOpApplied !== 'function') return
    const unsub = localClient.onOpApplied(() => { refreshCounts() })
    return () => { unsub?.() }
  }, [refreshCounts])

  useEffect(() => {
    if (!campId) return
    localClient.getCamp()
      .then((data) => { if (data) setCampName(data.name) })
      .catch(() => {})
  }, [campId])

  useEffect(() => {
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
    startedRoutes,
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
