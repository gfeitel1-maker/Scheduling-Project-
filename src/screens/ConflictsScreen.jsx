import { useState } from 'react'
import { S } from '../styles/shared'
import { usePendingConflicts } from '../hooks/usePendingConflicts'

// Falls back to its own hook instance only when not given one by App.jsx
// (e.g. rendered standalone in a test/dev context) — in the real app shell,
// App.jsx passes a single shared instance so the Sidebar badge and this
// screen's list can never disagree.

// Plain-language field descriptions, per the design spec — generic-fallback
// safe so unfamiliar entity/field pairs still read as a sentence, never a
// raw "entity: field" dump. '__PIN__' is a sentinel, never displayed as text.
const FIELD_LABELS = {
  'users.name': "A staff member's name",
  'users.role': "A staff member's role",
  'users.pin_hash': '__PIN__',
  'users.pin_salt': '__PIN__',
  'template_slots.activity_id': "A schedule slot's activity",
  'template_slots.group_id': "A schedule slot's assigned group",
  'template_slots.locked': "A schedule slot's lock status",
}

function describeConflict(entity, field) {
  const key = `${entity}.${field}`
  if (FIELD_LABELS[key] === '__PIN__') return null
  return FIELD_LABELS[key] || `A ${field.replace(/_/g, ' ')} change`
}

function relativeTime(timestamp) {
  if (!timestamp) return ''
  const diffMs = Date.now() - new Date(timestamp).getTime()
  const sec = Math.round(diffMs / 1000)
  if (sec < 60) return 'just now'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} minute${min !== 1 ? 's' : ''} ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr} hour${hr !== 1 ? 's' : ''} ago`
  const day = Math.round(hr / 24)
  return `${day} day${day !== 1 ? 's' : ''} ago`
}

function ChoiceBox({ side, label, isPin, disabled, onKeep }) {
  const [hover, setHover] = useState(false)
  return (
    <div
      style={{ ...S.mergeChoiceBox, ...(hover ? S.mergeChoiceBoxHover : {}) }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 3, color: 'var(--text)' }}>{label}</div>
      <div style={S.mergeMeta}>{relativeTime(side.timestamp)}</div>

      {isPin ? (
        <div style={S.mergePinLock}>
          <div style={{ fontSize: 20, marginBottom: 4 }}>🔒</div>
          <div>PIN was changed</div>
        </div>
      ) : (
        <div style={{ fontSize: 13.5, color: 'var(--text)', lineHeight: 1.5, margin: '10px 0' }}>
          {String(side.value)}
        </div>
      )}

      <button
        onClick={onKeep}
        disabled={disabled}
        style={{
          ...S.mergeBtnKeep,
          ...(hover && !disabled ? { background: 'var(--primary)', color: '#fff', borderColor: 'var(--primary)' } : {}),
          opacity: disabled ? 0.6 : 1,
          cursor: disabled ? 'default' : 'pointer',
        }}
      >
        {disabled ? 'Saving…' : 'Keep this version'}
      </button>
    </div>
  )
}

function ConflictCard({ conflict, resolveAuthorLabel, onResolve }) {
  const [resolving, setResolving] = useState(false)
  const [confirmedSide, setConfirmedSide] = useState(null)
  const [collapsing, setCollapsing] = useState(false)

  const description = describeConflict(conflict.entity, conflict.field)
  const isPin = conflict.isPin || description === null

  const latestTimestamp = [conflict.sideA.timestamp, conflict.sideB.timestamp]
    .filter(Boolean)
    .sort()
    .pop()

  async function keep(side, label) {
    if (resolving || confirmedSide) return
    setResolving(true)
    const result = await onResolve(conflict.id, side)
    setResolving(false)
    if (result && (result.status === 'applied' || result.status === 'queued')) {
      setConfirmedSide(label)
      setTimeout(() => setCollapsing(true), 1100)
    }
  }

  const labelA = resolveAuthorLabel(conflict.sideA)
  const labelB = resolveAuthorLabel(conflict.sideB)

  return (
    <div
      style={{
        ...S.mergeCard,
        ...(confirmedSide ? { borderColor: 'var(--success)' } : {}),
        ...(collapsing ? { maxHeight: 0, opacity: 0, marginBottom: 0, paddingTop: 0, paddingBottom: 0 } : { maxHeight: 400 }),
      }}
    >
      {confirmedSide ? (
        <div style={{ ...S.mergeConfirmed, opacity: collapsing ? 0 : 1 }}>
          ✓ Kept {confirmedSide}'s version
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>
              {isPin ? 'A PIN was changed on two devices' : description}
            </div>
            <div style={S.mergeMeta}>{relativeTime(latestTimestamp)}</div>
          </div>
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <ChoiceBox side={conflict.sideA} label={labelA} isPin={isPin} disabled={resolving} onKeep={() => keep('A', labelA)} />
            <ChoiceBox side={conflict.sideB} label={labelB} isPin={isPin} disabled={resolving} onKeep={() => keep('B', labelB)} />
          </div>
        </>
      )}
    </div>
  )
}

export default function ConflictsScreen({ pendingConflicts }) {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const fallback = pendingConflicts ? null : usePendingConflicts()
  const { conflicts, loading, resolveConflict, resolveAuthorLabel } = pendingConflicts || fallback

  return (
    <div style={{ maxWidth: 760 }}>
      {loading ? (
        <div style={{ color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', fontSize: 13 }}>Loading…</div>
      ) : conflicts.length === 0 ? (
        <div style={S.mergeEmptyState}>
          <div style={{ fontSize: 32, color: 'var(--success)', marginBottom: 10 }}>✓</div>
          <div style={{ fontFamily: 'var(--font-condensed)', fontSize: 16, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>
            No conflicts to resolve
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Everything's in sync.</div>
        </div>
      ) : (
        <>
          <div style={{ marginBottom: 20 }}>
            <div style={{
              fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 13, color: 'var(--text)',
              textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6,
            }}>
              {conflicts.length} conflict{conflicts.length !== 1 ? 's' : ''} need your attention
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              These happened while two devices made changes at the same time. Pick which version to keep for each one.
            </div>
          </div>

          {conflicts.map((c) => (
            <ConflictCard key={c.id} conflict={c} resolveAuthorLabel={resolveAuthorLabel} onResolve={resolveConflict} />
          ))}
        </>
      )}
    </div>
  )
}
