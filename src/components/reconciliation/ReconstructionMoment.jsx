import { useEffect, useRef } from 'react'
import { SETTLE_CAP_MS } from './reconstructionMoment.gate.js'
import { buildDomainRows, buildSummarySentence } from './reconstructionMomentCopy.js'

// docs/adr/2026-08-18-roots-reconstruction-moment-gating.md — redone after a
// product-register critique: the prior Canvas botanical-growth sequence (two
// phases, invented motion primitives, IBM Plex Mono labels) read as a
// foreign object against the app's own written motion contract. This is the
// quiet, product-native replacement: ONE motion (~SETTLE_CAP_MS), built
// entirely from existing primitives (importCardIn, --ease-out), Inter only.
// Reduced motion is satisfied for free by the global rule in src/index.css
// that strips any inline `animation: importCardIn ...` style — no new media
// query here.

// Small static identity glyph — a simple root/tree mark. Not animated: it's
// identity, not choreography (per the critique, "roots" survives only here).
function RootGlyph() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 3v8M12 11c-2 0-3 1.5-4 4M12 11c2 0 3 1.5 4 4M12 11c-1 2-1 5-2.5 7M12 11c1 2 1 5 2.5 7"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="3" r="1.6" fill="currentColor" />
    </svg>
  )
}

function DomainRow({ row, index }) {
  const isAttention = row.state === 'attention'
  return (
    <div
      style={{
        ...styles.row,
        animation: `importCardIn var(--motion-settle) var(--ease-out) both`,
        animationDelay: `${index * 50}ms`,
      }}
    >
      <span
        style={{
          ...styles.marker,
          background: isAttention ? 'var(--danger)' : 'var(--secondary)',
        }}
        aria-hidden="true"
      />
      <span style={styles.rowLabel}>{row.label}</span>
      <span style={{ ...styles.rowState, color: isAttention ? 'var(--danger)' : 'var(--text-secondary)' }}>
        {isAttention ? 'Needs a look' : 'Understood'}
      </span>
    </div>
  )
}

// `settling` is the boolean form of the ADR's `phase: 'growing' | 'settling'`.
// Phase 1 (settling=false): plain-text loading line, no choreography.
// Phase 2 (settling=true): the reveal described above, firing onSettled
// exactly once, ~SETTLE_CAP_MS after mount (or immediately under reduced
// motion, since the animation is stripped and there is nothing to wait on).
export default function ReconstructionMoment({ settling, domainCounts, onSettled }) {
  const settledFiredRef = useRef(false)

  useEffect(() => {
    if (!settling) return undefined
    const timer = setTimeout(() => {
      if (!settledFiredRef.current) {
        settledFiredRef.current = true
        onSettled?.()
      }
    }, SETTLE_CAP_MS)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- domainCounts/onSettled are read once per settling transition, not re-subscribed every render
  }, [settling])

  if (!settling) {
    return <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Checking this file against your camp…</p>
  }

  const rows = buildDomainRows(domainCounts)
  const sentence = buildSummarySentence(rows)

  return (
    <div style={styles.stage}>
      <div style={styles.heading}>
        <RootGlyph />
        <h2 style={styles.headingText}>Camp reconstructed</h2>
      </div>
      <p style={styles.sentence}>{sentence}</p>
      <div style={styles.grid}>
        {rows.map((row, index) => (
          <DomainRow key={row.key} row={row} index={index} />
        ))}
      </div>
    </div>
  )
}

const styles = {
  stage: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 14,
    padding: 24,
  },
  heading: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    color: 'var(--primary)',
  },
  headingText: {
    fontFamily: 'var(--font-sans)',
    fontSize: 18,
    fontWeight: 600,
    color: 'var(--text)',
  },
  sentence: {
    fontFamily: 'var(--font-sans)',
    fontSize: 14,
    color: 'var(--text-secondary)',
    marginTop: 8,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: 10,
    marginTop: 20,
  },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 12px',
    background: 'var(--bg)',
    borderRadius: 10,
  },
  marker: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  rowLabel: {
    fontFamily: 'var(--font-sans)',
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--text)',
    flex: 1,
  },
  rowState: {
    fontFamily: 'var(--font-sans)',
    fontSize: 12,
    fontWeight: 500,
  },
}
