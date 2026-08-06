import { useState, useEffect } from 'react'
import { localClient } from '../localClient'
import { FK_TARGET } from '../screens/recordLabels'

export function useRecordHistory(entity, entityId) {
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [names, setNames] = useState({})

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true)
      try {
        const rows = await localClient.getEntityHistory(entity, entityId)
        if (cancelled) return
        setHistory(Array.isArray(rows) ? rows : [])
        setError(null)
      } catch {
        if (!cancelled) setError('This record’s history could not be read just now.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [entity, entityId])

  useEffect(() => {
    const targets = [...new Set(history.map((h) => FK_TARGET[h.field]).filter(Boolean))]
    if (targets.length === 0) return
    let cancelled = false
    Promise.all(targets.map((ent) => localClient.list(ent).catch(() => [])))
      .then((results) => {
        if (cancelled) return
        const map = {}
        results.flat().forEach((row) => {
          if (row && row.id) map[row.id] = row.name ?? row.label ?? null
        })
        setNames(map)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [history])

  return { history, loading, error, names }
}
