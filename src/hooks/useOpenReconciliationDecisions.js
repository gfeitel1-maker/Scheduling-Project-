import { useCallback, useEffect, useRef, useState } from 'react'
import { localClient } from '../localClient'
import { openDecisionsToModel } from '../ingest/openDecisionsToModel.js'

// Owns the IPC call + translation to buildAttentionList's { model,
// decisionsById } shape (docs/adr/2026-08-28-persisted-reconciliation-
// decisions.md §5). Mirrors usePendingConflicts.js's mount-fetch shape.
//
// FOLLOW-UP: RootsHomeScreen.jsx does not exist on this branch yet (it lives
// on the unmerged feat/ws4-roots-home). Once that branch merges, wire this
// hook's `{ model, decisionsById }` into RootsHomeScreen's existing
// buildAttentionList({ model, decisionsById, structureIssues }) call — see
// src/ingest/openDecisionsToModel.js's own follow-up comment.
export function useOpenReconciliationDecisions() {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const mountedRef = useRef(true)

  const refresh = useCallback(() => {
    return localClient
      .listOpenReconciliationDecisions()
      .then((list) => {
        if (!mountedRef.current) return
        setRows(Array.isArray(list) ? list : [])
      })
      .catch(() => {
        // best-effort, same posture as usePendingConflicts' rehydration
        // fetch — a fetch failure must not crash the home screen
        if (mountedRef.current) setRows([])
      })
      .finally(() => {
        if (mountedRef.current) setLoading(false)
      })
  }, [])

  useEffect(() => {
    mountedRef.current = true
    refresh()
    return () => {
      mountedRef.current = false
    }
  }, [refresh])

  const dismiss = useCallback(async (ids) => {
    const idList = Array.isArray(ids) ? ids : [ids]
    const result = await localClient.dismissOpenReconciliationDecisions(idList)
    if (mountedRef.current) {
      setRows((prev) => prev.filter((row) => !idList.includes(row.id)))
    }
    return result
  }, [])

  const { model, decisionsById } = openDecisionsToModel(rows)

  return { rows, model, decisionsById, loading, dismiss, refresh }
}
