import { useEffect, useState } from 'react'
import { localClient } from '../localClient'
import { S } from '../styles/shared'
import { entityLabel, fieldLabel, formatMoment, FK_TARGET } from '../screens/recordLabels'

// Who changed what, and when, for one record. Everything shown here has been
// in the op log since the first edit; nothing new is stored to produce it.
//
// Values for foreign-key fields are shown as the referenced record's name.
// When the referent is itself deleted there is no name to show, and the old
// fallback printed the raw id — "changed Unit from 3ac1... to 9df0...", which
// explains nothing and makes the feature look broken. T18: say what is true
// instead. Booleans and id lists get the same treatment for the same reason.

function useReferenceNames(history) {
  const [names, setNames] = useState({})

  useEffect(() => {
    const targets = [...new Set(history.map((h) => FK_TARGET[h.field]).filter(Boolean))]
    if (targets.length === 0) return
    let cancelled = false
    Promise.all(targets.map((entity) => localClient.list(entity).catch(() => [])))
      .then((results) => {
        if (cancelled) return
        const map = {}
        results.flat().forEach((row) => {
          if (row && row.id) map[row.id] = row.name ?? row.label ?? null
        })
        setNames(map)
      })
      .catch(() => { /* names are a nicety; ids still read */ })
    return () => { cancelled = true }
  }, [history])

  return names
}

// T18 / CONSTITUTION Art. V. A history line is meant to explain a change, so
// anything it cannot put in words is worse than useless — a raw uuid mid-
// sentence ("changed Unit from 3ac1… to 9df0…") tells a director nothing and
// makes the feature look broken. Say what is true instead: the record it
// pointed at is gone.
function looksLikeAnId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value)
}

function renderValue(field, value, names) {
  if (value === null || value === undefined || value === '') return 'nothing'
  if (FK_TARGET[field]) return names[value] ?? 'a record that has since been deleted'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (Array.isArray(value)) {
    if (value.length === 0) return 'nothing'
    const named = value.map((v) => names[v]).filter(Boolean)
    // Only say "3 of them" when we genuinely cannot name them — a count is a
    // poor answer, but a list of uuids is not an answer at all.
    if (named.length === value.length) return named.join(', ')
    return `${value.length} ${value.length === 1 ? 'record' : 'records'}`
  }
  if (looksLikeAnId(value)) return 'a record that has since been deleted'
  return String(value)
}

function HistoryLine({ entry, names }) {
  const who = entry.author_name || 'Someone'
  const where = entry.device_name ? ` · ${entry.device_name}` : ''

  let sentence
  if (entry.field === '__deleted__') {
    sentence = `${who} deleted this`
  } else if (!('value' in entry)) {
    // Pin material, or a bulk replacement whose payload is machine detail.
    // The change is shown; the value never crosses the boundary.
    sentence = `${who} changed ${fieldLabel(entry.field).toLowerCase()}`
  } else if (entry.previous_value === null || entry.previous_value === undefined) {
    sentence = `${who} set ${fieldLabel(entry.field).toLowerCase()} to ${renderValue(entry.field, entry.value, names)}`
  } else {
    sentence = `${who} changed ${fieldLabel(entry.field).toLowerCase()} from ${renderValue(entry.field, entry.previous_value, names)} to ${renderValue(entry.field, entry.value, names)}`
  }

  return (
    <li style={histStyles.line}>
      <div style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.5 }}>{sentence}</div>
      <div style={S.mergeMeta}>{formatMoment(entry.timestamp)}{where}</div>
    </li>
  )
}

export default function RecordHistory({ entity, entityId, name, onClose }) {
  const [history, setHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

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

  const names = useReferenceNames(history)
  const newestFirst = [...history].reverse()

  return (
    <div style={S.overlay} onClick={onClose}>
      <div style={{ ...S.modalLg, maxHeight: '80vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 4 }}>
          <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 16, color: 'var(--text)' }}>
            History
          </div>
          <button onClick={onClose} style={S.btnSecondary}>Close</button>
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
          {entityLabel(entity)}{name ? ` · ${name}` : ''}
        </div>

        {loading ? (
          <div style={S.stateLoading}>Loading…</div>
        ) : error ? (
          <div style={S.errorBanner}>{error}</div>
        ) : newestFirst.length === 0 ? (
          <div style={S.emptyState}>
            <div style={S.emptyStateBody}>No changes recorded for this record yet.</div>
          </div>
        ) : (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {newestFirst.map((entry) => (
              <HistoryLine key={entry.seq} entry={entry} names={names} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

const histStyles = {
  line: {
    padding: '10px 0',
    borderBottom: '1px solid var(--border)',
  },
}
