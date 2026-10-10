import { useState, useEffect, useCallback } from 'react'
import { localClient } from '../localClient'
import { AREA_TABLE } from '../components/layout/navSections'
import { loadSidebarState, shouldOfferFold } from '../components/layout/sidebarState'
import { getSetupGaps } from '../engine/readiness'
import { useLatestTimeout } from './useLatestTimeout'
import { activitiesListed } from '../screens/setupListSelectors.js'

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
  const [backupRevealable, setBackupRevealable] = useState(false)
  const { start: startBackupStatusReset, cancel: cancelBackupStatusReset } = useLatestTimeout()
  const [counts, setCounts] = useState(null)
  // Which camp the counts above were read for, and whether every list read
  // succeeded. A failed read counts as 0, so counts that are incomplete or
  // belong to the previous camp must not drive a one-time decision
  // (useSetupReviewed).
  const [countsFor, setCountsFor] = useState(null)
  const [syncStatus, setSyncStatus] = useState(null)
  const [offerShown, setOfferShown] = useState(false)
  const [openQuestionCount, setOpenQuestionCount] = useState(0)

  const refreshCounts = useCallback(async () => {
    const areas = Object.keys(AREA_TABLE)
    // An AREA_TABLE entry is a table name, or { table, kind } when two nav rows
    // read the same table and must not report each other's rows (T124).
    const specFor = (area) => {
      const entry = AREA_TABLE[area]
      return typeof entry === 'string' ? { table: entry, kind: null } : entry
    }
    let complete = true
    const results = await Promise.all(
      areas.map((area) => localClient.list(specFor(area).table).catch(() => { complete = false; return [] }))
    )
    const next = {}
    areas.forEach((area, i) => {
      const { kind } = specFor(area)
      const rows = Array.isArray(results[i]) ? results[i] : []
      // Activities: the Activities screen's own selector, so pinned-event rows
      // (which back fixed events) are not counted (audit follow-up to I4).
      if (area === 'activities' && campId) { next[area] = activitiesListed(rows, { campId }).length; return }
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
    setCountsFor({ campId, complete })
    // Import questions the director left open: "setup looks complete" is not
    // true while any remain. A failed read counts as none, like the lists above.
    const open = await Promise.resolve(localClient.listOpenReconciliationDecisions?.()).catch(() => [])
    setOpenQuestionCount(Array.isArray(open) ? open.length : 0)
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
    // A reset armed by an earlier ok/error backup must not clear a caution that follows it.
    cancelBackupStatusReset()
    setBackupStatus('running')
    let status
    try {
      const result = await localClient.backupProject()
      status = result?.error ? 'error' : result?.docBackupError ? 'caution' : 'ok'
      if (!result?.error) setBackupRevealable(true)
    } catch {
      status = 'error'
    }
    setBackupStatus(status)
    if (status !== 'caution') startBackupStatusReset(() => setBackupStatus(null), 3000)
  }, [startBackupStatusReset, cancelBackupStatusReset])

  const handleShowBackup = useCallback(async () => {
    try {
      const result = await localClient.showBackupInFolder()
      if (result?.error) setBackupStatus('error')
    } catch {
      setBackupStatus('error')
    }
  }, [])

  return {
    counts,
    countsFor,
    campName,
    syncStatus,
    projectPath,
    isDevDb,
    buildLabel,
    backupStatus,
    handleBackupNow,
    backupRevealable,
    handleShowBackup,
    offerShown,
    setOfferShown,
    openQuestionCount,
  }
}
