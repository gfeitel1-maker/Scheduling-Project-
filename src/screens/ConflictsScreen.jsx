import { useEffect, useRef, useState } from 'react'
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
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ marginBottom: 4 }} aria-hidden="true">
            <rect x="5" y="11" width="14" height="10" rx="2" stroke="var(--text-secondary)" strokeWidth="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" />
          </svg>
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

// Maps every non-success syncClient.write()/resolveConflict() status to an
// inline message for the card. 'conflict' keeps the original round-1/round-2
// copy; 'timeout'/'disconnected' get connectivity-specific copy; 'error' (and
// anything unrecognized) gets a generic fallback so no status can ever fall
// through silently with buttons just re-enabling and no explanation.
export function noticeForStatus(status) {
  switch (status) {
    case 'conflict':
      return "This changed again — pick again below."
    case 'timeout':
    case 'disconnected':
      return "Couldn't reach the network — try again when connected."
    case 'error':
    default:
      return 'Something went wrong — try again.'
  }
}

// Task 10 round-4 Fix 1: this card no longer owns the setTimeout chain that
// drives the actual removal of a resolved conflict from shared state — that
// now lives in usePendingConflicts (see its resolveConflict), which is the
// long-lived instance that survives this card unmounting. The card only
// owns a purely-LOCAL, purely-visual "hold then collapse" timer, driven off
// the `resolved` prop rather than its own resolve-call result, so:
//   - if this exact card instance unmounts mid-animation, its local timer is
//     cleared on unmount (via the effect below) and can never call anything
//     that touches shared state — there's nothing left for it to corrupt.
//   - if a FRESH card mounts for a conflict that's already in resolvedMeta
//     (resolved while this card was unmounted, e.g. the director navigated
//     away and back within the hold window), it renders the confirmed
//     checkmark state immediately instead of a pristine "unresolved" one
//     that would later vanish with no explanation.
function ConflictCard({ conflict, resolved, resolveAuthorLabel, onResolve }) {
  const [resolving, setResolving] = useState(false)
  const [collapsing, setCollapsing] = useState(false)
  const [errorNotice, setErrorNotice] = useState(null)
  const localTimersRef = useRef([])

  const description = describeConflict(conflict.entity, conflict.field)
  const isPin = conflict.isPin || description === null

  const latestTimestamp = [conflict.sideA.timestamp, conflict.sideB.timestamp]
    .filter(Boolean)
    .sort()
    .pop()

  const labelA = resolveAuthorLabel(conflict.sideA)
  const labelB = resolveAuthorLabel(conflict.sideB)
  const confirmedSide = resolved ? (resolved.side === 'A' ? labelA : labelB) : null

  // Purely-local visual collapse timer, re-derived from `resolved` (shared
  // state) rather than from this card's own keep() call — so a fresh mount
  // that inherits an already-resolved conflict still gets the same
  // hold-then-collapse visual. Cleared on unmount / whenever `resolved`
  // changes, so it can never fire after this card instance is gone.
  useEffect(() => {
    if (!resolved) {
      setCollapsing(false)
      return
    }
    const holdTimer = setTimeout(() => setCollapsing(true), 1100)
    localTimersRef.current.push(holdTimer)
    return () => {
      clearTimeout(holdTimer)
      localTimersRef.current = localTimersRef.current.filter((t) => t !== holdTimer)
    }
  }, [resolved])

  useEffect(() => {
    return () => {
      for (const t of localTimersRef.current) clearTimeout(t)
      localTimersRef.current = []
    }
  }, [])

  async function keep(side) {
    if (resolving || resolved) return
    setResolving(true)
    setErrorNotice(null)
    const result = await onResolve(conflict.id, side)
    setResolving(false)
    if (!(result && (result.status === 'applied' || result.status === 'queued'))) {
      // Every other status (conflict / timeout / disconnected / error / any
      // unrecognized future status) must surface SOME explanation — don't
      // silently re-enable the buttons with no feedback. noticeForStatus
      // always returns a string, even for an unrecognized status.
      setErrorNotice(noticeForStatus(result && result.status))
    }
    // On success, this component does nothing further itself — `resolved`
    // arrives back down as a prop once the hook's setResolvedMeta commits,
    // and the effect above picks up the hold/collapse animation from there.
  }

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
          {resolved && resolved.queued
            ? `Saved — will sync when connected (${confirmedSide}'s version)`
            : `✓ Kept ${confirmedSide}'s version`}
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 700, fontSize: 15, color: 'var(--text)' }}>
              {isPin ? 'A PIN was changed on two devices' : description}
            </div>
            <div style={S.mergeMeta}>{relativeTime(latestTimestamp)}</div>
          </div>
          {errorNotice && (
            <div style={{ fontSize: 12.5, color: 'var(--text-secondary)', marginBottom: 10 }}>
              {errorNotice}
            </div>
          )}
          <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
            <ChoiceBox side={conflict.sideA} label={labelA} isPin={isPin} disabled={resolving} onKeep={() => keep('A')} />
            <ChoiceBox side={conflict.sideB} label={labelB} isPin={isPin} disabled={resolving} onKeep={() => keep('B')} />
          </div>
        </>
      )}
    </div>
  )
}

export default function ConflictsScreen({ pendingConflicts }) {
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const fallback = pendingConflicts ? null : usePendingConflicts()
  const { conflicts, loading, resolveConflict, resolveAuthorLabel, resolvedMeta } = pendingConflicts || fallback

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
              {conflicts.length} conflict{conflicts.length !== 1 ? 's' : ''} {conflicts.length !== 1 ? 'need' : 'needs'} your attention
            </div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              These happened while two devices made changes at the same time. Pick which version to keep for each one.
            </div>
          </div>

          {conflicts.map((c) => (
            <ConflictCard
              key={c.id}
              conflict={c}
              resolved={resolvedMeta ? resolvedMeta[c.id] : null}
              resolveAuthorLabel={resolveAuthorLabel}
              onResolve={resolveConflict}
            />
          ))}
        </>
      )}
    </div>
  )
}
