import { useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '../../styles/shared'
import { DOMAIN_OF, REQUIRED_GAP_DOMAIN } from './domainRollup.js'
import { isDecisionResolvedFor } from '../../screens/reconciliationTriage.js'

// Extracted from ReconciliationScreen.jsx (root-map port,
// docs/adr/2026-08-18-rootmap-screen-port.md §1/"Files affected") so both
// the pre-existing card-list render path AND the new RootMapPanel call the
// SAME card renderer — never two copies drifting.

// Exported so RootMap's chip info layer can reuse this exact copy for its
// glanceable provenance cue, rather than inventing a second wording (spec
// docs/work/specs/2026-08-21-roots-metaphor-visual.md, Governor consolidation
// "Information layer").
// eslint-disable-next-line react-refresh/only-export-components -- shared copy map, not a component
export const CONFIDENCE_COPY = {
  high: 'clearly stated in the file',
  medium: 'inferred from context',
  low: 'a guess — worth a second look',
  conflict: 'in conflict with what Shoresh already has',
}

function formatFieldValue(value) {
  if (value == null) return 'unset'
  if (typeof value === 'object') return Object.entries(value).map(([k, v]) => `${k}: ${formatFieldValue(v)}`).join(', ')
  return String(value)
}

// Exported for the same reason as CONFIDENCE_COPY above.
// eslint-disable-next-line react-refresh/only-export-components -- shared helper, not a component
export function plainEvidenceSentence(evidence) {
  if (!evidence || typeof evidence !== 'object') return null
  const parts = []
  if (Array.isArray(evidence.matched_groups) && evidence.matched_groups.length > 0) {
    parts.push(`seen across ${evidence.matched_groups.length} group${evidence.matched_groups.length === 1 ? '' : 's'}`)
  }
  if (typeof evidence.occupied_days === 'number' && typeof evidence.operating_days === 'number') {
    parts.push(`observed on ${evidence.occupied_days} of ${evidence.operating_days} operating days`)
  }
  if (Array.isArray(evidence.groups_in_scope) && evidence.groups_in_scope.length > 0) {
    parts.push(`across ${evidence.groups_in_scope.join(', ')}`)
  }
  return parts.length > 0 ? parts.join('; ') : null
}

function evidenceDisclosure(decision) {
  const confidenceLine = decision.confidence ? (CONFIDENCE_COPY[decision.confidence] ?? decision.confidence) : null
  const evidence = decision.evidence
  const hasLocator = evidence && typeof evidence === 'object' && (evidence.row != null || evidence.sheet != null)
  const hasEditorIdentity = evidence && typeof evidence === 'object' && (evidence.editedBy != null || evidence.editedAt != null)

  if (hasLocator && hasEditorIdentity) {
    return {
      table: true,
      fromFile: formatFieldValue(decision.proposedValue),
      fromFileDetail: evidence.row != null ? `seen in row ${evidence.row}${evidence.sheet ? `, ${evidence.sheet}` : ''}` : `seen in ${evidence.sheet}`,
      current: formatFieldValue(evidence.currentValue),
      currentDetail: evidence.editedBy
        ? `set by hand${evidence.editedAt ? ` ${evidence.editedAt}` : ''} (${evidence.editedBy})`
        : `set by hand${evidence.editedAt ? ` ${evidence.editedAt}` : ''}`,
    }
  }

  const sentence = plainEvidenceSentence(evidence)
  const text = [confidenceLine ? `From this file — ${confidenceLine}.` : null, sentence].filter(Boolean).join(' ')
  return { table: false, text: text || 'No evidence details available for this field.' }
}

function useMaxHeightReveal(expanded) {
  const ref = useRef(null)
  const reduced = prefersReducedMotion()
  const [maxHeight, setMaxHeight] = useState(0)
  useEffect(() => {
    if (expanded && ref.current) setMaxHeight(ref.current.scrollHeight)
    else if (!expanded) setMaxHeight(0)
  }, [expanded])
  const style = reduced
    ? { overflow: 'hidden', opacity: expanded ? 1 : 0, transition: `opacity var(--motion-base) var(--ease-out)` }
    : { overflow: 'hidden', maxHeight, transition: `max-height var(--motion-base) var(--ease-out)` }
  return { ref, style }
}

function EvidenceDetail({ decision, expanded }) {
  const { ref, style } = useMaxHeightReveal(expanded)
  const disclosure = evidenceDisclosure(decision)
  return (
    <div style={style}>
      <div ref={ref} style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6, paddingBottom: 2 }}>
        {disclosure.table ? (
          <div style={cardStyles.evidenceTable}>
            <div style={cardStyles.evidenceTableHeader}>From this file</div>
            <div style={cardStyles.evidenceTableHeader}>Current Shoresh record</div>
            <div>{disclosure.fromFile}</div>
            <div>{disclosure.current}</div>
            <div style={cardStyles.evidenceTableDetail}>{disclosure.fromFileDetail}</div>
            <div style={cardStyles.evidenceTableDetail}>{disclosure.currentDetail}</div>
          </div>
        ) : (
          disclosure.text
        )}
      </div>
    </div>
  )
}

function LegacyPriorityBody({ decision }) {
  const [showActivities, setShowActivities] = useState(false)
  const { ref, style } = useMaxHeightReveal(showActivities)
  const activities = decision.activities ?? []
  return (
    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
      {decision.reason}
      {activities.length > 0 && (
        <>
          {' '}
          <button className="press-97" onClick={() => setShowActivities((v) => !v)} style={cardStyles.linkButton}>
            {showActivities ? 'Hide the activities' : `Show the ${activities.length} activities`}
          </button>
          <div style={style}>
            <ul ref={ref} style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              {activities.map((a) => (
                <li key={a.entityId}>{a.name}</li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}

function isIdentityDecision(decision) {
  return decision.kind === 'resolve_conflict' && (decision._held ? decision._heldKind === 'identity' : true)
}

// fix, panel round 2 (Tester, "metadata jargon") — the card subtitle used to
// render raw schema names (`elective_sets · Chugim · Structure`) for the
// electives nudge. A per-kind override in camp vocabulary; every other kind
// keeps the existing entity/domain rendering unchanged.
const KIND_SUBTITLE = {
  elective_candidate: (decision) => `Electives${decision.entityName ? ` · ${decision.entityName}` : ''}`,
  elective_candidates_truncated: () => 'Electives',
}

function subtitleFor(decision) {
  const override = KIND_SUBTITLE[decision.kind]
  if (override) return override(decision)
  return `${decision.entity} · ${decision.entityName ?? 'unnamed'} · ${DOMAIN_OF[decision.entity] ?? 'Structure'}`
}

function questionFor(decision) {
  const name = decision.entityName ?? 'this record'
  if (decision.kind === 'resolve_conflict') {
    return decision._held && decision._heldKind === 'stale'
      ? `Keep the current value for "${name}"'s ${decision.field?.[0]} or use the file's value?`
      : `Is "${name}" a new record, or one you already have?`
  }
  if (decision.kind === 'confirm_change') return `"${name}" was hand-edited — keep it or overwrite from the file?`
  if (decision.kind === 'review_legacy_priority') {
    const count = decision.count ?? 0
    return `Review priority for ${count} ${count === 1 ? 'activity' : 'activities'} carried over from an earlier import`
  }
  // Slice 3a (docs/adr/2026-08-22-nested-schedules-electives-and-events.md §4
  // addendum). Reworded (fix, panel round 2 — Tester "mental-model trap"):
  // the ORIGINAL wording ("open the elective space?") let a director expect
  // the file's activities to come along for the ride. Confirming only ever
  // creates an EMPTY elective_set (the standing invariant — electives are
  // authored, never reconstructed from a file); the copy now says so
  // explicitly, names the header text verbatim, and says where offerings
  // actually come from.
  if (decision.kind === 'elective_candidate') {
    return `This looks like an elective period. Create an empty "${decision.entityName ?? 'Electives'}" elective set? `
      + `(You'll add the activities on the Electives screen.)`
  }
  if (decision.kind === 'elective_candidates_truncated') return decision.reason
  return `Use the file's value for "${name}"?`
}

function summaryOf(decision, answer) {
  if (!answer) return 'Resolved'
  if (answer.action === 'looks_right') return 'Using the file’s value'
  if (answer.choice === 'accept') return 'Will use the file’s value'
  if (answer.choice === 'keep') return 'Keeping the current value'
  if (answer.choice === 'existing') return 'Using your existing record'
  if (answer.choice === 'create') return 'Adding as new'
  if (decision.kind === 'elective_candidate' && answer.choice === 'confirm') return 'Empty elective set created'
  if (decision.kind === 'elective_candidate' && answer.choice === 'decline') return 'Not an elective period — left as-is'
  if (answer.resolved) return 'Acknowledged'
  return 'Resolved'
}

function RadioOption({ label, description, onClick }) {
  return (
    <label style={cardStyles.radioOption}>
      <input type="radio" onChange={onClick} style={{ marginTop: 3 }} />
      <span>
        <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{label}</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{description}</div>
      </span>
    </label>
  )
}

function ResolutionControls({ decision, onAnswer }) {
  if (decision.kind === 'confirm_value') {
    return (
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button className="press-97" onClick={() => onAnswer({ action: 'looks_right' })} style={cardStyles.btnCompactPrimary}>Use this value</button>
        <button className="press-97" onClick={() => onAnswer({ action: 'edited' })} style={cardStyles.btnCompactSecondary}>Keep current</button>
      </div>
    )
  }

  if (decision.kind === 'review_legacy_priority' || decision.kind === 'elective_candidates_truncated') {
    return (
      <div style={{ marginTop: 10 }}>
        <button className="press-97" onClick={() => onAnswer({ resolved: true })} style={cardStyles.btnCompactSecondary}>Acknowledge</button>
      </div>
    )
  }

  if (decision.kind === 'confirm_change') {
    return (
      <div style={{ marginTop: 10 }}>
        <RadioOption label={`Use the file's value${decision.proposedValue != null ? ` — "${JSON.stringify(decision.proposedValue)}"` : ''}`} description="Overwrites what's in Shoresh now." onClick={() => onAnswer({ choice: 'accept' })} />
        <RadioOption label="Keep the current value" description="Ignores this file's value going forward for this field." onClick={() => onAnswer({ choice: 'keep' })} />
      </div>
    )
  }

  // Slice 3a — Confirm creates ONE empty elective_set (named the header text
  // verbatim, editable afterward on the Electives screen); Not electives
  // writes nothing.
  if (decision.kind === 'elective_candidate') {
    return (
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button className="press-97" onClick={() => onAnswer({ choice: 'confirm' })} style={cardStyles.btnCompactPrimary}>Create elective set</button>
        <button className="press-97" onClick={() => onAnswer({ choice: 'decline' })} style={cardStyles.btnCompactSecondary}>Not electives</button>
      </div>
    )
  }

  if (isIdentityDecision(decision)) {
    return (
      <div style={{ marginTop: 10 }}>
        {(decision._candidates ?? []).map((c) => (
          <RadioOption
            key={c.entity_id}
            label={`Use "${c.name ?? c.entity_id}"`}
            description="Matches an existing record."
            onClick={() => onAnswer({ choice: 'existing', entity_id: c.entity_id })}
          />
        ))}
        <RadioOption label="Something else — add as new" description="Creates a new record from the file's value." onClick={() => onAnswer({ choice: 'create' })} />
        <RadioOption label="Leave unset for now" description="Skip this decision — it stays here for you to come back to; nothing is written for it." onClick={() => onAnswer({ choice: 'skip' })} />
      </div>
    )
  }
  return (
    <div style={{ marginTop: 10 }}>
      <RadioOption label={`Use the file's value — "${JSON.stringify(decision.proposedValue)}"`} description="Overwrites what's in Shoresh now." onClick={() => onAnswer({ choice: 'accept' })} />
      <RadioOption label="Keep the current value" description="Ignores this file's value going forward for this field." onClick={() => onAnswer({ choice: 'keep' })} />
    </div>
  )
}

function useContentCrossfade(dep) {
  const [entered, setEntered] = useState(true)
  const mounted = useRef(false)
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      return
    }
    setEntered(false)
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [dep])
  return {
    opacity: entered ? 1 : 0,
    transition: 'opacity var(--motion-fast) var(--ease-out)',
  }
}

export function DecisionCard({ decision, rank, answer, onAnswer, expanded, onToggleEvidence }) {
  const resolved = isDecisionResolvedFor(decision, { [decision.id]: answer })
  const cardStyle = rank === 'hold' ? cardStyles.cardHold : cardStyles.cardStandard
  const question = questionFor(decision)
  const showRemember = resolved && isIdentityDecision(decision) && answer?.choice === 'existing'
  const contentFade = useContentCrossfade(resolved)

  return (
    <div style={{ ...cardStyle, opacity: resolved ? 0.6 : 1, transition: 'opacity var(--motion-fast) var(--ease-out)' }}>
      <div style={{ fontWeight: 600, fontSize: rank === 'hold' ? 14 : 13, color: 'var(--text)' }}>{question}</div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
        {subtitleFor(decision)}
      </div>

      <div style={contentFade}>
      {resolved ? (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
          {`✓ ${summaryOf(decision, answer)}`}
          {' '}
          <button className="press-97" onClick={() => onAnswer(null)} style={cardStyles.linkButton}>Undo</button>
          {showRemember && (
            <label style={cardStyles.rememberRow}>
              <input
                type="checkbox"
                checked={answer.remember ?? true}
                onChange={(e) => onAnswer({ ...answer, remember: e.target.checked })}
              />
              Remember this for next time
            </label>
          )}
        </div>
      ) : (
        <>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 8 }}>
            {`From this file${decision.confidence ? ` · ${CONFIDENCE_COPY[decision.confidence] ?? decision.confidence}` : ''}`}
            {' '}
            <button className="press-97" onClick={onToggleEvidence} style={cardStyles.linkButton}>Why?</button>
          </div>
          {decision.from && decision.to && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
              {`${decision.from.day} · ${decision.from.timeBlock} → ${decision.to.day} · ${decision.to.timeBlock}`}
            </div>
          )}
          {decision.kind === 'review_legacy_priority' ? (
            <LegacyPriorityBody decision={decision} />
          ) : (
            <EvidenceDetail decision={decision} expanded={expanded} />
          )}
          <ResolutionControls decision={decision} onAnswer={onAnswer} />
        </>
      )}
      </div>
    </div>
  )
}

export function RequiredGapCard({ decision, dismissed, onDismiss, onUndismiss, onNavigate }) {
  const question = decision.message
    ? `${decision.label} aren't set up yet — ${decision.message}`
    : `${decision.label} is required before you can build a schedule.`

  return (
    <div style={{ ...cardStyles.cardHold, position: 'relative', opacity: dismissed ? 0.6 : 1, transition: 'opacity var(--motion-fast) var(--ease-out)' }}>
      <div style={cardStyles.readyToBuildTab}>READY TO BUILD?</div>
      <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>{question}</div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 4 }}>
        setup · {decision.label} · {REQUIRED_GAP_DOMAIN[decision.screen] ?? 'Structure'}
      </div>

      {dismissed ? (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>
          {`Skipped — ${decision.label} still isn't set up.`}
          {' '}
          <button className="press-97" onClick={onUndismiss} style={cardStyles.linkButton}>Undo</button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button
            className="press-97"
            onClick={() => onNavigate?.(decision.screen)}
            style={cardStyles.btnCompactAccent}
          >
            {`Set up ${decision.label}`}
          </button>
          <button className="press-97" onClick={onDismiss} style={cardStyles.btnCompactSecondary}>
            {`Skip ${decision.label} for now — I'll add it later`}
          </button>
        </div>
      )}
    </div>
  )
}

export function RequiredGapSummaryCard({ decisions, dismissedGaps, onDismiss, onUndismiss, onNavigate }) {
  const labels = decisions.map((d) => d.label).join(', ')

  return (
    <div style={{ ...cardStyles.cardHold, position: 'relative' }}>
      <div style={cardStyles.readyToBuildTab}>READY TO BUILD?</div>
      <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text)' }}>
        {`Your camp still needs: ${labels}`}
      </div>

      <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {decisions.map((d) => {
          const dismissed = dismissedGaps.has(d.id)
          return (
            <div key={d.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              {dismissed ? (
                <>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {`Skipped — ${d.label} still isn't set up.`}
                  </span>
                  <button className="press-97" onClick={() => onUndismiss(d.id)} style={cardStyles.linkButton}>Undo</button>
                </>
              ) : (
                <>
                  <span style={{ fontSize: 13, color: 'var(--text)' }}>{d.label}</span>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button
                      className="press-97"
                      onClick={() => onNavigate?.(d.screen)}
                      style={cardStyles.btnCompactAccent}
                    >
                      {`Set up ${d.label}`}
                    </button>
                    <button className="press-97" onClick={() => onDismiss(d.id)} style={cardStyles.btnCompactSecondary}>
                      {`Skip ${d.label} for now — I'll add it later`}
                    </button>
                  </div>
                </>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const cardStyles = {
  cardHold: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    borderLeft: '4px solid var(--accent)',
    padding: 16,
    marginBottom: 12,
    boxShadow: '0 1px 3px color-mix(in srgb, var(--text) 8%, transparent)',
  },
  cardStandard: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    borderLeft: '4px solid var(--border)',
    padding: 12,
    marginBottom: 6,
    boxShadow: '0 1px 3px color-mix(in srgb, var(--text) 8%, transparent)',
  },
  radioOption: {
    display: 'flex',
    gap: 8,
    alignItems: 'flex-start',
    padding: '6px 0',
    cursor: 'pointer',
  },
  linkButton: {
    background: 'none',
    border: 'none',
    color: 'var(--primary)',
    fontSize: 12,
    cursor: 'pointer',
    padding: 0,
    fontFamily: 'inherit',
  },
  btnCompactPrimary: {
    padding: '5px 12px',
    background: 'var(--primary)',
    color: '#fff',
    border: 'none',
    borderRadius: 7,
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  readyToBuildTab: {
    position: 'absolute',
    top: -9,
    left: 12,
    background: 'var(--bg)',
    color: 'var(--accent)',
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    letterSpacing: '0.06em',
    fontWeight: 600,
    padding: '0 4px',
  },
  btnCompactAccent: {
    padding: '5px 12px',
    background: 'var(--accent)',
    color: '#fff',
    border: 'none',
    borderRadius: 7,
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  btnCompactSecondary: {
    padding: '5px 12px',
    background: 'var(--surface)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 7,
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  rememberRow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    marginLeft: 12,
    fontSize: 12,
    color: 'var(--text-secondary)',
    cursor: 'pointer',
  },
  evidenceTable: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '2px 16px',
  },
  evidenceTableHeader: {
    fontWeight: 600,
    color: 'var(--text)',
  },
  evidenceTableDetail: {
    color: 'var(--text-secondary)',
    fontSize: 11,
  },
}
