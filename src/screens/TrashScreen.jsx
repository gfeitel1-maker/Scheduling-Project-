import { useEffect, useState } from 'react'
import { localClient } from '../localClient'
import { S } from '../styles/shared'
import RecordHistory from '../components/RecordHistory'
import { entityLabel, formatMoment, restoreCaveat } from './recordLabels'

// What was deleted, by whom, when — and a way to get it back. All of it has
// been in the op log since the first delete; none of it was ever shown.
//
// Retention is unbounded on purpose: a camp's delete volume is small, and a
// window would be a second thing to explain whose only effect is hiding rows
// the director may still want.

// Every message a restore can produce, in the director's words. No enum keys
// reach the screen, and a refusal says what is true rather than blaming the
// person who asked.
const OUTCOME_COPY = {
  'not-restorable': 'This kind of record is not restorable here.',
  'no-history': 'The main computer does not hold enough of this record’s history to rebuild it.',
  'not-deleted': 'This record is already back.',
  forbidden: 'Only an admin can restore records.',
  // Unlike every refusal above, this one is deterministic and permanent: the
  // colliding name still belongs to a different, live record, so retrying
  // does nothing until that record is renamed or removed. "Try again" would
  // be a lie here — this is the generic form, used when the colliding
  // record's name isn't available (e.g. the queued-restore list, which has
  // no `existing` detail); outcomeMessage names it when it can.
  unique_field: 'A record with that name already exists, so this can’t be restored. Rename or remove the existing one first.',
}

function outcomeMessage(error, existing) {
  if (error === 'unique_field' && existing?.name) {
    return `A record named “${existing.name}” already exists, so this can’t be restored. Rename or remove the existing one first.`
  }
  return OUTCOME_COPY[error] ?? 'That restore did not go through. Try again in a moment.'
}

function restoredMessage(row) {
  const who = row.name || entityLabel(row.entity)
  const caveat = restoreCaveat(row.entity)
  return caveat ? `${who} is back. ${caveat}` : `${who} is back.`
}

function Notice({ tone, children }) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderLeft: `3px solid var(--${tone})`,
        borderRadius: 6,
        padding: '10px 12px',
        marginBottom: 14,
        fontSize: 13,
        color: 'var(--text)',
        lineHeight: 1.5,
        background: 'var(--surface)',
      }}
    >
      {children}
    </div>
  )
}

export default function TrashScreen({ role }) {
  const [rows, setRows] = useState([])
  const [waiting, setWaiting] = useState([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState(null)
  const [notice, setNotice] = useState(null)
  // The second, explicit offer after a parent comes back. Never automatic: a
  // cascade cannot tell a child deleted alongside its parent from one deleted
  // deliberately, earlier, and would bring the second kind back silently.
  const [childOffer, setChildOffer] = useState(null)
  const [historyFor, setHistoryFor] = useState(null)

  const isAdmin = role === 'admin'

  // `loading` starts true and is only ever turned off. A reload after a
  // restore deliberately does not flash the loading state back on — the list
  // is already on screen and the director just acted on it.
  async function load() {
    try {
      const [deleted, pending] = await Promise.all([
        localClient.listDeleted(),
        localClient.listPendingRestores(),
      ])
      setRows(Array.isArray(deleted) ? deleted : [])
      setWaiting(Array.isArray(pending) ? pending : [])
    } catch {
      setNotice({ tone: 'danger', text: 'The deleted records could not be read just now.' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    // Wrapped rather than called directly so the lint rule can see that no
    // state is set synchronously during the effect — every setState below
    // happens after an await.
    void (async () => { await load() })()
  }, [])

  async function restore(row) {
    setBusyId(row.entity_id)
    setNotice(null)
    setChildOffer(null)
    try {
      const result = await localClient.restoreEntity(row.entity, row.entity_id)
      if (result?.queued) {
        const caveat = restoreCaveat(row.entity)
        setNotice({
          tone: 'text-secondary',
          text: `Waiting for the main computer to bring ${row.name || 'this record'} back. It will happen as soon as this device reaches it — you can close the app in the meantime.${caveat ? ` ${caveat}` : ''}`,
        })
      } else if (result?.ok) {
        setNotice({ tone: 'success', text: restoredMessage(row) })
        if (result.deleted_children?.length) {
          setChildOffer({ parent: row, children: result.deleted_children })
        }
      } else {
        setNotice({ tone: 'danger', text: outcomeMessage(result?.error, result?.existing) })
      }
    } catch (err) {
      setNotice({
        tone: 'danger',
        text: /admin role required/i.test(err?.message ?? '')
          ? OUTCOME_COPY.forbidden
          : 'That restore did not go through — check your connection and try again.',
      })
    } finally {
      setBusyId(null)
      await load()
    }
  }

  async function restoreChildren(offer) {
    setBusyId(offer.parent.entity_id)
    let brought = 0
    let stillOut = 0
    for (const child of offer.children) {
      try {
        const result = await localClient.restoreEntity(child.entity, child.entity_id)
        if (result?.ok || result?.queued) brought += 1
        else stillOut += 1
      } catch {
        stillOut += 1
      }
    }
    setChildOffer(null)
    setBusyId(null)
    // T24 applies here too — these are the same records, restored in a batch,
    // and the same thing did not come back with them. Deduped because a batch
    // of ten groups should say it once, not ten times.
    const caveats = [...new Set(offer.children.map((c) => restoreCaveat(c.entity)).filter(Boolean))]
    const count = stillOut
      ? `${brought} of ${offer.children.length} brought back. ${stillOut} still to do.`
      : `${brought} record${brought === 1 ? '' : 's'} brought back.`
    setNotice({
      tone: stillOut ? 'danger' : 'success',
      text: brought > 0 && caveats.length ? `${count} ${caveats.join(' ')}` : count,
    })
    await load()
  }

  const grouped = rows.reduce((acc, row) => {
    ;(acc[row.entity] ??= []).push(row)
    return acc
  }, {})

  return (
    <div style={{ maxWidth: 860 }}>
      {notice && <Notice tone={notice.tone === 'text-secondary' ? 'border' : notice.tone}>{notice.text}</Notice>}

      {childOffer && (
        <Notice tone="border">
          <div style={{ marginBottom: 8 }}>
            {childOffer.children.length} record{childOffer.children.length === 1 ? ' was' : 's were'} deleted with{' '}
            {childOffer.parent.name || 'it'}: {childOffer.children.map((c) => c.name || `an unnamed ${entityLabel(c.entity).toLowerCase()}`).join(', ')}.
            They are still deleted.
          </div>
          <button className="press-97"
            style={S.btnSecondary}
            disabled={busyId !== null}
            onClick={() => restoreChildren(childOffer)}
          >
            Bring those back too
          </button>{' '}
          <button className="press-97" style={S.btnSecondary} onClick={() => setChildOffer(null)}>Leave them</button>
        </Notice>
      )}

      {waiting.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={trashStyles.sectionTitle}>Waiting on the main computer</div>
          {waiting.map((item) => (
            <div key={item.pendingId} style={trashStyles.waitingRow}>
              <span style={{ color: 'var(--text)' }}>
                {/* T18: this rendered the raw entity_id — "Group · 8f3c1a02-…",
                    which tells a director nothing about which group it is and
                    makes the row unactionable. The name is what identifies a
                    record to them; when it is genuinely unknown, say so. */}
                {entityLabel(item.entity)} · {item.name || 'name not known on this device'}
              </span>
              <span style={S.mergeMeta}>
                {item.last_error
                  ? outcomeMessage(item.last_error)
                  : 'Will be restored as soon as this device reaches the main computer.'}
              </span>
            </div>
          ))}
        </div>
      )}

      {loading ? (
        <div style={S.stateLoading}>Loading…</div>
      ) : rows.length === 0 ? (
        <div style={S.emptyStateTall}>
          <div style={S.emptyStateTitle}>Nothing deleted</div>
          <div style={S.emptyStateBody}>Deleted records appear here and can be restored.</div>
        </div>
      ) : (
        Object.entries(grouped).map(([entity, entityRows]) => (
          <div key={entity} style={{ marginBottom: 22 }}>
            <div style={trashStyles.sectionTitle}>{entityLabel(entity)}</div>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={S.th}>Name</th>
                  <th style={S.th}>Deleted</th>
                  <th style={S.th}>By</th>
                  <th style={S.th}></th>
                </tr>
              </thead>
              <tbody>
                {entityRows.map((row) => (
                  <tr key={row.entity_id}>
                    <td style={S.td}>{row.name || '—'}</td>
                    <td style={S.td}>{formatMoment(row.deleted_at)}</td>
                    <td style={S.td}>
                      {row.deleted_by_name || 'Unknown'}
                      {row.deleted_on_device_name ? ` · ${row.deleted_on_device_name}` : ''}
                    </td>
                    <td style={{ ...S.td, textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button className="press-97"
                        style={S.btnSecondary}
                        onClick={() => setHistoryFor(row)}
                      >
                        History
                      </button>{' '}
                      {isAdmin && (
                        <button className="press-97"
                          style={{ ...S.btnPrimary, ...(busyId ? S.buttonDisabled : {}) }}
                          disabled={busyId !== null}
                          onClick={() => restore(row)}
                        >
                          {busyId === row.entity_id ? 'Restoring…' : 'Restore'}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}

      {!isAdmin && rows.length > 0 && (
        <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginTop: 8 }}>
          Only an admin can restore records.
        </div>
      )}

      {historyFor && (
        <RecordHistory
          entity={historyFor.entity}
          entityId={historyFor.entity_id}
          name={historyFor.name}
          onClose={() => setHistoryFor(null)}
        />
      )}
    </div>
  )
}

const trashStyles = {
  sectionTitle: {
    fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 12,
    textTransform: 'uppercase', letterSpacing: '0.08em',
    color: 'var(--text-secondary)', marginBottom: 6,
  },
  waitingRow: {
    display: 'flex', justifyContent: 'space-between', gap: 12,
    padding: '8px 0', borderBottom: '1px solid var(--border)', fontSize: 13,
  },
}
