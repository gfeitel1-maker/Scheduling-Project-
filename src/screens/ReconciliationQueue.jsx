import { useState } from 'react'
import { S } from '../styles/shared'
import { isDecisionResolved, isEditableDecision, isBackedConfirmChange } from './reconciliationResolutions.js'

// D2 — the decision-queue shell, generalizing HeldResolution's existing
// one-at-a-time pattern (ImportScreen.jsx:1233) from conflicts-only to
// Phase C's confirm_value / confirm_change / review_legacy_priority kinds.
// docs/adr/2026-08-10-ingestion-phaseD-experience.md (D2). Layout follows
// the approved mockup, panels 2-5:
// docs/work/specs/mockups/2026-08-10-phaseD-reconciliation/reconciliation-experience.html
//
// Renderer state only, same discipline as HeldResolution: `answers` is owned
// by the parent (ImportScreen) so it survives "leave and return" across the
// queue being closed/reopened, exactly like the existing held/dismissHeld
// pattern already does for conflicts. This is also why LegacyPriorityCard's
// sub-review checkmarks live in `answer.reviewedIds` (parent state) rather
// than the card's own useState — round 2 fix, see below.

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
// Dashed divider per the mockup (panel 2/3's why-disclosure treatment).
function WhyDisclosure({ evidence }) {
  const [open, setOpen] = useState(false)
  return (
    <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px dashed color-mix(in srgb, var(--border) 80%, transparent)' }}>
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

const capsLabel = {
  fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--text-secondary)',
}

// Observed/Proposed/Unknown, literally (brief's structure). "Edit" is ONLY
// offered when isEditableDecision says the edited value has a real
// destination in the commit payload — round 2 HIGH fix: an Edit that
// resolves the card but cannot apply the value is a silent-write bug, not a
// convenience. A non-editable decision gets "Looks right" only.
function ConfirmValueCard({ decision, answer, onAnswer, onEditField, style }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(() => fmtValue(decision.proposedValue))
  const editable = isEditableDecision(decision)

  return (
    <div style={style}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 10 }}>{decision.entityName}</div>

      {decision.reason && (
        <div style={{ marginBottom: 10 }}>
          <div style={capsLabel}>Observed</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6, marginTop: 2 }}>{decision.reason}</div>
        </div>
      )}

      {decision.proposedValue !== null && (
        <div style={{ marginBottom: 10 }}>
          <div style={capsLabel}>Proposed</div>
          {editing
            ? <input type="text" value={draft} onChange={(e) => setDraft(e.target.value)} style={{ marginTop: 4, fontSize: 13, fontFamily: 'inherit', padding: '3px 6px', border: '1px solid var(--border)', borderRadius: 5 }} />
            : <div style={{ fontSize: 13, color: 'var(--text)', fontWeight: 600, marginTop: 2 }}>{fmtValue(decision.proposedValue)}</div>}
        </div>
      )}
      {(decision.unknowns ?? []).length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={capsLabel}>Unknown</div>
          <div style={{ fontSize: 12, fontStyle: 'italic', color: 'var(--text-secondary)', marginTop: 2 }}>{decision.unknowns.join(', ')}</div>
        </div>
      )}

      {editing ? (
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button className="press-97" onClick={() => {
            onEditField(decision, draft)
            onAnswer(decision.id, { action: 'edited', value: draft })
            setEditing(false)
          }} style={S.btnPrimary}>Save</button>
          <button className="press-97" onClick={() => setEditing(false)} style={S.btnSecondary}>Cancel</button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
          <Choice selected={answer?.action === 'looks_right'} onClick={() => onAnswer(decision.id, { action: 'looks_right' })}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
              {answer?.action === 'looks_right' ? '● ' : '○ '}Looks right
            </span>
          </Choice>
          {editable && (
            <Choice selected={answer?.action === 'edited'} onClick={() => setEditing(true)}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>
                {answer?.action === 'edited' ? '● ' : '○ '}Edit
              </span>
            </Choice>
          )}
        </div>
      )}

      <WhyDisclosure evidence={decision.evidence} />
    </div>
  )
}

// The ADR's explicit ask: distinctly firmer than a routine confirm_value —
// danger-tinted top-edge gradient wash (mockup panel 3), an explicit
// firmer-note banner (mirroring ReconciliationLedger's `cleared` treatment),
// and reframed buttons ("Looks right" undersells overwriting a director's
// confirmed value). ONLY rendered when isBackedConfirmChange is true — see
// ReadOnlyChangeCard below for the non-backed (fixed-event drift) case.
function ConfirmChangeCard({ decision, answer, onAnswer, style }) {
  const fields = decision.field
  return (
    <div style={{
      ...style,
      borderTop: '2px solid var(--danger)',
      background: 'linear-gradient(to bottom, color-mix(in srgb, var(--danger) 10%, var(--surface-elevated)), var(--surface-elevated) 64px)',
    }}>
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

// Round 2 MEDIUM-HIGH fix — a fixed-event moved/scopeChanged confirm_change
// has no backend resolution consumer (field: null) and is not something a
// director "set by hand" in the protected-field sense; the previous
// Overwrite/Keep gate was theater (neither button did anything different).
// This renders it honestly instead: a plain, non-danger acknowledgement of a
// drift fact, no write implied either way.
function ReadOnlyChangeCard({ decision, answer, onAnswer, style }) {
  const acked = answer?.ack === true
  return (
    <div style={style}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>{decision.entityName}</div>
      {decision.reason && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 14, lineHeight: 1.6 }}>{decision.reason}</div>}
      <button className="press-97" onClick={() => onAnswer(decision.id, { ack: true })} style={acked ? S.btnSecondary : S.btnPrimary}>
        {acked ? '✓ Got it' : 'Got it'}
      </button>
      <WhyDisclosure evidence={decision.evidence} />
    </div>
  )
}

// C2b/OQ3: batched, ALL-OR-NOTHING at the top-level queue — the whole batch
// is ONE decision. Sub-progress (which individual activities have been
// looked at) lives only inside this expanded card, never surfaces as N
// separate top-level cards, and never emits a resolution/write. Round 2 fix:
// `reviewedIds` now lives in `answer` (the parent's queueAnswers), not local
// useState, so leaving and reopening the queue does not wipe progress.
function LegacyPriorityCard({ decision, answer, onAnswer, style }) {
  const [expanded, setExpanded] = useState((answer?.reviewedIds ?? []).length > 0)
  const activities = decision.activities ?? []
  const reviewedIds = answer?.reviewedIds ?? []
  const pct = activities.length > 0 ? Math.round((reviewedIds.length / activities.length) * 1000) / 10 : 0

  function toggle(entityId) {
    const next = reviewedIds.includes(entityId) ? reviewedIds.filter((id) => id !== entityId) : [...reviewedIds, entityId]
    onAnswer(decision.id, { reviewedIds: next, resolved: false })
  }

  return (
    <div style={style}>
      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>
        {decision.count} {decision.count === 1 ? 'activity carries' : 'activities carry'} a priority Shoresh never confirmed
      </div>
      {decision.reason && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, lineHeight: 1.6 }}>{decision.reason}</div>}

      {!expanded ? (
        <button className="press-97" onClick={() => setExpanded(true)} style={S.btnSecondary}>Review each</button>
      ) : (
        <div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
            {activities.map((a) => (
              <button
                key={a.entityId}
                className="press-97"
                onClick={() => toggle(a.entityId)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left', fontFamily: 'inherit',
                  fontSize: 13, padding: '6px 10px', borderRadius: 6, cursor: 'pointer',
                  background: reviewedIds.includes(a.entityId) ? 'color-mix(in srgb, var(--success) 10%, var(--surface))' : 'var(--surface)',
                  border: `1px solid ${reviewedIds.includes(a.entityId) ? 'var(--success)' : 'var(--border)'}`,
                }}
              >
                <span>{reviewedIds.includes(a.entityId) ? '✓' : '○'}</span>{a.name}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
            <span>{reviewedIds.length} of {activities.length} reviewed</span>
            <div style={{ flex: 1, height: 5, borderRadius: 3, background: 'var(--border)', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${pct}%`, background: 'var(--anchor)', borderRadius: 3, transition: 'width var(--motion-settle) var(--ease-out)' }} />
            </div>
          </div>
          <button
            className="press-97"
            onClick={() => onAnswer(decision.id, { reviewedIds, resolved: true })}
            disabled={reviewedIds.length < activities.length}
            style={{ ...S.btnPrimary, opacity: reviewedIds.length < activities.length ? 0.45 : 1 }}
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

  // Round 2 fix — steps to the next UNRESOLVED card (searching forward, then
  // wrapping once), not a plain modulo cycle through every card including
  // already-resolved ones. "Defer — decide later" (mockup panel 5) reuses
  // this exact behavior: deferring IS just moving on without answering.
  function goToNextUnresolved() {
    for (let step = 1; step <= decisions.length; step++) {
      const idx = (index + step) % decisions.length
      if (!isDecisionResolved(decisions[idx], answers?.[decisions[idx].id])) { setIndex(idx); return }
    }
  }

  function back() {
    setIndex((i) => Math.max(0, i - 1))
  }

  const cardStyle = { background: 'var(--surface-elevated)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 18px' }

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 18px', marginBottom: 16 }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
        Review {decisions.length} decision{decisions.length === 1 ? '' : 's'}
      </div>
      <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', marginTop: 4, marginBottom: 10 }}>
        Decision {index + 1} of {decisions.length} — {resolvedCount} of {decisions.length} resolved
      </div>

      {/* Progress dots (mockup panel 5) — a compact visual row, not a
          scrolling list; each dot is clickable and reaches every card, so a
          deferred one is always returnable. */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14, flexWrap: 'wrap' }}>
        {decisions.map((d) => {
          const resolved = isDecisionResolved(d, answers?.[d.id])
          const isCurrent = d.id === current.id
          return (
            <button
              key={d.id}
              onClick={() => setIndex(decisions.indexOf(d))}
              aria-label={decisionLabel(d)}
              title={decisionLabel(d)}
              style={{
                width: 12, height: 12, borderRadius: '50%', border: isCurrent ? '2px solid var(--accent)' : 'none',
                padding: 0, cursor: 'pointer',
                background: resolved ? 'var(--success)' : isCurrent ? 'var(--accent)' : 'var(--border)',
              }}
            />
          )
        })}
      </div>

      {current.kind === 'confirm_value' && (
        <ConfirmValueCard key={current.id} decision={current} answer={answers?.[current.id]} onAnswer={onAnswer} onEditField={onEditField} style={cardStyle} />
      )}
      {current.kind === 'confirm_change' && (
        isBackedConfirmChange(current)
          ? <ConfirmChangeCard key={current.id} decision={current} answer={answers?.[current.id]} onAnswer={onAnswer} style={cardStyle} />
          : <ReadOnlyChangeCard key={current.id} decision={current} answer={answers?.[current.id]} onAnswer={onAnswer} style={cardStyle} />
      )}
      {current.kind === 'review_legacy_priority' && (
        <LegacyPriorityCard key={current.id} decision={current} answer={answers?.[current.id]} onAnswer={onAnswer} style={cardStyle} />
      )}

      <div style={{ borderTop: '1px solid var(--border)', marginTop: 14, paddingTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <button className="press-97" onClick={back} disabled={index === 0} style={{ background: 'none', border: 'none', cursor: index === 0 ? 'default' : 'pointer', fontFamily: 'inherit', fontSize: 12, color: index === 0 ? 'var(--text-secondary)' : 'var(--text)', opacity: index === 0 ? 0.5 : 1, padding: 0 }}>
            ← Back
          </button>
          <button className="press-97" onClick={goToNextUnresolved} disabled={allResolved} style={{ background: 'none', border: 'none', cursor: allResolved ? 'default' : 'pointer', fontFamily: 'inherit', fontSize: 12, color: 'var(--text-secondary)', opacity: allResolved ? 0.5 : 1, padding: 0 }}>
            Defer — decide later
          </button>
          <button className="press-97" onClick={onReturnToSummary} style={S.btnSecondary}>Return to summary</button>
        </div>
        {allResolved
          ? <button className="press-97" onClick={onDone} style={S.btnPrimary}>Done</button>
          : <button className="press-97" onClick={goToNextUnresolved} style={S.btnPrimary}>Next →</button>}
      </div>
    </div>
  )
}
