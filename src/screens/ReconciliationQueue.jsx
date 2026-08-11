import { useState } from 'react'
import { S } from '../styles/shared'
import { isDecisionResolved } from './reconciliationResolutions.js'

// D2 — the decision-queue shell, generalizing HeldResolution's existing
// one-at-a-time pattern (ImportScreen.jsx:1233) from conflicts-only to
// Phase C's confirm_value / confirm_change / review_legacy_priority kinds.
// docs/adr/2026-08-10-ingestion-phaseD-experience.md (D2).
//
// Renderer state only, same discipline as HeldResolution: `answers` is owned
// by the parent (ImportScreen) so it survives "leave and return" across the
// queue being closed/reopened, exactly like the existing held/dismissHeld
// pattern already does for conflicts.

function Choice({ selected, onClick, danger, children }) {
  return (
    <button
      className="press-97"
      onClick={onClick}
      style={{
        display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
        padding: '10px 12px', borderRadius: 7, fontFamily: 'inherit',
        background: selected
          ? `color-mix(in srgb, var(${danger ? '--danger' : '--primary'}) 8%, var(--surface))`
          : 'var(--surface)',
        border: `1.5px solid ${selected ? `var(${danger ? '--danger' : '--primary'})` : 'var(--border)'}`,
      }}
    >
      {children}
    </button>
  )
}

// D3 — always rendered, never hidden/disabled (plain-transparency
// requirement). evidence is null for every decision kind today (Phase C's
// own module doc) — this is an honest shell, not evidence population.
function WhyDisclosure({ evidence }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid color-mix(in srgb, var(--border) 60%, transparent)' }}>
      <button
        className="press-97"
        onClick={() => setOpen((o) => !o)}
        style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', padding: 0, fontSize: 12, color: 'var(--text-secondary)' }}
      >
        Why does Shoresh think this?
      </button>
      {open && (
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          {evidence ? 'Evidence' : "This isn't populated yet — coming in a later update."}
        </div>
      )}
    </div>
  )
}

function fmtValue(v) {
  if (v === null || v === undefined || v === '') return '(empty)'
  if (typeof v === 'object') return Object.entries(v).map(([k, val]) => `${k}: ${fmtValue(val)}`).join(', ')
  return String(v)
}

function ConfirmValueCard({ decision, answer, onAnswer, onEditField, style }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(() => fmtValue(decision.proposedValue))

  return (
    <div style={style}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>{decision.entityName}</div>
      {decision.reason && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.6 }}>{decision.reason}</div>}

      {decision.proposedValue !== null && (
        <div style={{ display: 'flex', gap: 10, fontSize: 13, marginBottom: 14 }}>
          <span style={{ color: 'var(--text-secondary)', fontSize: 12, width: 96 }}>Shoresh proposes</span>
          {editing
            ? <input type="text" value={draft} onChange={(e) => setDraft(e.target.value)} style={{ fontSize: 13, fontFamily: 'inherit', padding: '3px 6px', border: '1px solid var(--border)', borderRadius: 5 }} />
            : <span style={{ color: 'var(--text)', fontWeight: 600 }}>{fmtValue(decision.proposedValue)}</span>}
        </div>
      )}
      {(decision.unknowns ?? []).length > 0 && (
        <div style={{ fontSize: 12, fontStyle: 'italic', color: 'var(--text-secondary)', marginBottom: 12 }}>
          Not sure yet: {decision.unknowns.join(', ')}
        </div>
      )}

      {editing ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="press-97" onClick={() => {
            onEditField(decision, draft)
            onAnswer(decision.id, { action: 'edited', value: draft })
            setEditing(false)
          }} style={S.btnPrimary}>Save</button>
          <button className="press-97" onClick={() => setEditing(false)} style={S.btnSecondary}>Cancel</button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Choice selected={answer?.action === 'looks_right'} onClick={() => onAnswer(decision.id, { action: 'looks_right' })}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
              {answer?.action === 'looks_right' ? '● ' : '○ '}Looks right
            </span>
          </Choice>
          <Choice selected={answer?.action === 'edited'} onClick={() => setEditing(true)}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
              {answer?.action === 'edited' ? '● ' : '○ '}Edit
            </span>
          </Choice>
        </div>
      )}

      <WhyDisclosure evidence={decision.evidence} />
    </div>
  )
}

// The ADR's explicit ask: distinctly firmer than a routine confirm_value —
// danger-tinted border/wash, an explicit firmer-note banner (mirroring
// ReconciliationLedger's `cleared` treatment), and reframed buttons ("Looks
// right" undersells overwriting a director's confirmed value).
function ConfirmChangeCard({ decision, answer, onAnswer, style }) {
  const fields = Array.isArray(decision.field) ? decision.field : [decision.field]
  return (
    <div style={{ ...style, border: '1px solid var(--danger)', borderTop: '3px solid var(--danger)' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, fontSize: 12, fontWeight: 600, color: 'var(--danger)',
      }}>
        <span>⌫</span> This overwrites a value a director set by hand
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>{decision.entityName}</div>
      {decision.reason && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.6 }}>{decision.reason}</div>}

      <div style={{ display: 'flex', gap: 10, fontSize: 13, marginBottom: 14 }}>
        <span style={{ color: 'var(--text-secondary)', fontSize: 12, width: 110 }}>{fields.join(', ')} — new value</span>
        <span style={{ color: 'var(--text)', fontWeight: 600 }}>{fmtValue(decision.proposedValue)}</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <Choice danger selected={answer?.choice === 'accept'} onClick={() => onAnswer(decision.id, { choice: 'accept' })}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
            {answer?.choice === 'accept' ? '● ' : '○ '}Overwrite with new value
          </span>
        </Choice>
        <Choice selected={answer?.choice === 'keep'} onClick={() => onAnswer(decision.id, { choice: 'keep' })}>
          <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
            {answer?.choice === 'keep' ? '● ' : '○ '}Keep my value
          </span>
        </Choice>
      </div>

      <WhyDisclosure evidence={decision.evidence} />
    </div>
  )
}

// C2b/OQ3: batched, ALL-OR-NOTHING at the top-level queue — the whole batch
// is ONE decision. Sub-progress (which individual activities have been
// looked at) lives only inside this expanded card, never surfaces as N
// separate top-level cards, and never emits a resolution/write.
function LegacyPriorityCard({ decision, onAnswer, style }) {
  const [expanded, setExpanded] = useState(false)
  const [reviewed, setReviewed] = useState(new Set())
  const activities = decision.activities ?? []

  return (
    <div style={style}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>
        {decision.count} {decision.count === 1 ? 'activity carries' : 'activities carry'} an unreviewed legacy priority
      </div>
      {decision.reason && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.6 }}>{decision.reason}</div>}

      {!expanded ? (
        <button className="press-97" onClick={() => setExpanded(true)} style={S.btnSecondary}>Review each</button>
      ) : (
        <div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
            {reviewed.size} of {activities.length} reviewed
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
            {activities.map((a) => (
              <button
                key={a.entityId}
                className="press-97"
                onClick={() => setReviewed((prev) => { const n = new Set(prev); n.has(a.entityId) ? n.delete(a.entityId) : n.add(a.entityId); return n })}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', fontFamily: 'inherit',
                  fontSize: 13, padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
                  background: reviewed.has(a.entityId) ? 'color-mix(in srgb, var(--success) 10%, var(--surface))' : 'var(--surface)',
                  border: `1px solid ${reviewed.has(a.entityId) ? 'var(--success)' : 'var(--border)'}`,
                }}
              >
                <span>{reviewed.has(a.entityId) ? '✓' : '○'}</span>{a.name}
              </button>
            ))}
          </div>
          <button
            className="press-97"
            onClick={() => onAnswer(decision.id, { resolved: true })}
            disabled={reviewed.size < activities.length}
            style={{ ...S.btnPrimary, opacity: reviewed.size < activities.length ? 0.45 : 1 }}
          >
            Mark all reviewed
          </button>
        </div>
      )}

      <WhyDisclosure evidence={decision.evidence} />
    </div>
  )
}

function decisionLabel(decision) {
  return decision.entityName ?? (decision.kind === 'review_legacy_priority' ? `${decision.count} legacy priorities` : decision.id)
}

export function ReconciliationQueue({ decisions, answers, onAnswer, onEditField, onReturnToSummary, onDone }) {
  const [index, setIndex] = useState(0)
  if (!decisions || decisions.length === 0) return null

  const current = decisions[Math.min(index, decisions.length - 1)]
  const resolvedCount = decisions.filter((d) => isDecisionResolved(d, answers?.[d.id])).length
  const allResolved = resolvedCount === decisions.length

  function next() {
    setIndex((i) => (i + 1) % decisions.length)
  }

  const cardStyle = { background: 'var(--surface-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 18px' }

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 18px', marginBottom: 16 }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
        Review {decisions.length} decision{decisions.length === 1 ? '' : 's'}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4, marginBottom: 14 }}>
        {resolvedCount} of {decisions.length}
      </div>

      <div style={{ borderBottom: '1px solid var(--border)', paddingBottom: 12, marginBottom: 14 }}>
        {decisions.map((d) => {
          const resolved = isDecisionResolved(d, answers?.[d.id])
          const isCurrent = d.id === current.id
          const glyph = resolved ? '✓' : isCurrent ? '●' : '○'
          const color = resolved ? 'var(--success)' : isCurrent ? 'var(--accent)' : 'var(--text-secondary)'
          return (
            <button
              key={d.id}
              onClick={() => setIndex(decisions.indexOf(d))}
              style={{
                display: 'flex', alignItems: 'baseline', gap: 8, width: '100%', textAlign: 'left',
                background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit',
                padding: '4px 0', fontSize: 13, color: resolved || isCurrent ? 'var(--text)' : 'var(--text-secondary)',
                fontWeight: isCurrent ? 600 : 400,
              }}
            >
              <span style={{ color, fontSize: 13 }}>{glyph}</span>
              <span style={{ flex: 1 }}>{decisionLabel(d)}</span>
            </button>
          )
        })}
      </div>

      {current.kind === 'confirm_value' && (
        <ConfirmValueCard key={current.id} decision={current} answer={answers?.[current.id]} onAnswer={onAnswer} onEditField={onEditField} style={cardStyle} />
      )}
      {current.kind === 'confirm_change' && (
        <ConfirmChangeCard key={current.id} decision={current} answer={answers?.[current.id]} onAnswer={onAnswer} style={cardStyle} />
      )}
      {current.kind === 'review_legacy_priority' && (
        <LegacyPriorityCard key={current.id} decision={current} answer={answers?.[current.id]} onAnswer={onAnswer} style={cardStyle} />
      )}

      <div style={{ borderTop: '1px solid var(--border)', marginTop: 14, paddingTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="press-97" onClick={next} disabled={decisions.length < 2} style={S.btnSecondary}>Next</button>
          <button className="press-97" onClick={onReturnToSummary} style={S.btnSecondary}>Return to summary</button>
        </div>
        {allResolved && (
          <button className="press-97" onClick={onDone} style={S.btnPrimary}>Done</button>
        )}
      </div>
    </div>
  )
}
