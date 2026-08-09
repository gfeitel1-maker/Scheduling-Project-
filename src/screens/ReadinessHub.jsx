// The Setup Readiness hub — the onboarding home base. A full-screen expansion
// of the sidebar's setup rollup that answers one question loudly (can this camp
// build a week yet, and if not, what is missing) then offers a calm,
// per-category way in.
//
// docs/work/onboarding-reconciliation/S5-READINESS-HUB-DESIGN.md
// docs/adr/2026-08-08-s5-readiness-six-state-model.md
//
// This screen is the six-state layer's first consumer. It reads FROM
// getSetupGaps via getReadiness — it never replaces the binary blocking core
// (the generation gate keeps calling getSetupGaps directly). The
// reconciliation-preview ledger (§7) is a separate slice (S5b/T75) and is not
// built here; with no live plan, categories rest at Ready / Missing / Optional.

import { useState, useEffect } from 'react'
import { localClient } from '../localClient'
import { useCohorts } from '../hooks/useCohorts'
import { useSetupCounts } from '../hooks/useSetupCounts'
import { getReadiness, describeReadiness } from '../engine/readiness'
import { downloadWorkbook } from '../utils/exportWorkbook.js'
import { INGESTIBLE_ENTITIES } from '../ingest/extractEntities'
import { S, useEnterTransition, prefersReducedMotion } from '../styles/shared'
import { STATE_VISUAL, statusWord, buildHubRows, verdictState } from './readinessHubModel'

export default function ReadinessHub({ campId, onNavigate }) {
  const { counts } = useSetupCounts(campId)
  const { activeCohort } = useCohorts(campId)
  const [preparing, setPreparing] = useState(false)
  const enter = useEnterTransition('liftFade')

  const loading = counts == null

  // A missing collection counts as empty, never as satisfied — so we render
  // skeletons until counts resolve rather than flash a premature "Ready".
  if (loading) {
    return (
      <div style={{ maxWidth: 760, ...enter }}>
        <SkeletonLine width={340} height={22} />
        <div style={{ height: 28 }} />
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} style={{ padding: '12px 0' }}><SkeletonLine width={260} height={16} /></div>
        ))}
      </div>
    )
  }

  const collections = {
    cohorts: Array(counts.cohorts || 0),
    tiers: Array(counts.tiers || 0),
    groups: Array(counts.groups || 0),
    days: Array(counts.days || 0),
    timeBlocks: Array(counts.timeblocks || 0),
    activities: Array(counts.activities || 0),
    anchors: Array(counts.anchors || 0),
    dayOverrides: Array(counts.dayoverrides || 0),
  }

  const readiness = getReadiness(collections)
  const { blocking, attention } = describeReadiness(readiness)
  const groups = buildHubRows(readiness, counts)
  const blocked = readiness.some((r) => r.state === 'missing')
  // needs-attention is forward-scaffolding: getReadiness is called here with no
  // `signals`, so describeReadiness's attention is always null in production
  // today. This branch goes live once S5b's reconciliation signals are wired.
  const state = verdictState({ blocked, attention })
  const brandNew = readiness
    .filter((r) => r.kind === 'required')
    .every((r) => r.state === 'missing')

  async function downloadWorksheet() {
    setPreparing(true)
    try {
      const camp = await localClient.getCamp().catch(() => null)
      const entities = {}
      for (const entity of INGESTIBLE_ENTITIES) {
        entities[entity] = await localClient.list(entity).catch(() => [])
      }
      const base_generation = await localClient.latestOpSeq().catch(() => 0)
      downloadWorkbook({
        ...entities,
        camp_id: camp?.id ?? null,
        cohort_id: activeCohort?.id ?? null,
        base_generation,
      })
    } finally {
      setPreparing(false)
    }
  }

  return (
    <div style={{ maxWidth: 760, ...enter }}>
      <Headline key={state} state={state} blocking={blocking} attention={attention} />

      {brandNew && (
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 4 }}>
          New here?{' '}
          <button onClick={() => onNavigate('import')} style={linkBtn}>Import last year</button>
          {' '}to fill most of this in at once, or add each below.
        </div>
      )}

      <div style={{ marginTop: 28 }}>
        <Group label="Required" rows={groups.required} onNavigate={onNavigate} onDownload={downloadWorksheet} preparing={preparing} />
        <Group label="Optional" rows={groups.optional} onNavigate={onNavigate} onDownload={downloadWorksheet} preparing={preparing} />
        <Group label="Programs" rows={groups.programs} onNavigate={onNavigate} onDownload={downloadWorksheet} preparing={preparing} muted />
      </div>
    </div>
  )
}

// The engine only ever produces the ready/blocked sentences (byte-for-byte
// blocking-truth core); the needs-attention headline has no describeReadiness
// counterpart to reuse, so it lives here as a local override.
const NEEDS_ATTENTION_HEADLINE = 'Ready to build a week, with a few things to check.'

// Bridges the verdict's three-state enum to the six-state glyph grammar —
// 'blocked' maps to the same visual as 'missing'. Kept explicit (rather than
// indexing STATE_VISUAL[state] directly) so an unrecognized state falls back
// safely instead of crashing on `visual.color`.
const HEADLINE_VISUAL = {
  ready: STATE_VISUAL.ready,
  'needs-attention': STATE_VISUAL['needs-attention'],
  blocked: STATE_VISUAL.missing,
}

function Headline({ state, blocking, attention }) {
  const visual = HEADLINE_VISUAL[state] ?? STATE_VISUAL.missing
  const headline = state === 'needs-attention' ? NEEDS_ATTENTION_HEADLINE : blocking
  const attentionLine = state === 'needs-attention'
    ? { fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 500, color: 'var(--accent)', marginTop: 3 }
    : { fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--text-secondary)', marginTop: 2 }

  const fade = useCrossFade()

  return (
    <div role="status" aria-live="polite">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 0, ...fade }}>
        <span
          aria-hidden="true"
          style={{ width: 24, flexShrink: 0, fontSize: 18, fontWeight: 700, color: visual.color, lineHeight: '28px' }}
        >
          {visual.glyph}
        </span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontFamily: 'var(--font-condensed)', fontWeight: 600, fontSize: 20, color: 'var(--text)', lineHeight: '28px' }}>
            {headline}
          </div>
          {attention && (
            <div style={attentionLine}>
              {attention}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// Cross-fades the glyph+text block on mount, mirroring useEnterTransition
// (shared.js) exactly: the caller remounts Headline via `key={state}` on
// state change, so this only ever needs a mount fade — no synchronous
// setState in the effect body, just the rAF-deferred flip to `entered`.
// Under prefers-reduced-motion it returns no transition at all, an instant
// swap.
function useCrossFade() {
  const reduced = prefersReducedMotion()
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    if (reduced) return
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [reduced])

  if (reduced) return {}
  return { opacity: entered ? 1 : 0, transition: 'opacity var(--motion-fast) var(--ease-out)' }
}

function Group({ label, rows, onNavigate, onDownload, preparing, muted }) {
  return (
    <section style={{ borderTop: '1px solid var(--border)', padding: '20px 0' }}>
      <div style={{
        fontFamily: 'var(--font-condensed)', fontSize: 10, fontWeight: 700,
        letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--text-secondary)',
        marginBottom: 6, opacity: muted ? 0.7 : 1,
      }}>
        {label}
      </div>
      {rows.map((r, i) => (
        <CategoryRow
          key={r.key}
          row={r}
          last={i === rows.length - 1}
          onNavigate={onNavigate}
          onDownload={onDownload}
          preparing={preparing}
        />
      ))}
    </section>
  )
}

function CategoryRow({ row, last, onNavigate, onDownload, preparing }) {
  const [hover, setHover] = useState(false)
  const visual = STATE_VISUAL[row.state]
  const word = statusWord(row)
  const wordColor = row.state === 'missing'
    ? 'var(--danger)'
    : row.state === 'needs-attention' || row.state === 'in-progress'
      ? 'var(--accent)'
      : 'var(--text-secondary)'

  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '12px 8px',
        borderBottom: last ? 'none' : '1px solid color-mix(in srgb, var(--border) 60%, transparent)',
        background: hover ? 'var(--bg)' : 'transparent',
        transition: 'background var(--motion-fast) var(--ease-out)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 13, flexShrink: 0, fontSize: 11, fontWeight: 700, textAlign: 'center',
          color: visual.color, opacity: visual.dim ? 0.5 : 1,
        }}
      >
        {visual.glyph}
      </span>
      <span style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-sans)', fontSize: 14, fontWeight: 500, color: 'var(--text)' }}>
        {row.label}
      </span>
      <span
        data-state={row.state}
        style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: wordColor, flexShrink: 0 }}
      >
        {word}
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 12, marginLeft: 12, flexShrink: 0 }}>
        {row.screen && (
          <button
            onClick={() => onNavigate(row.screen)}
            style={{ ...S.btnSecondary, fontSize: 12, padding: '4px 10px' }}
          >
            Review on screen
          </button>
        )}
        {row.doors === 'two' && (
          <button
            onClick={onDownload}
            disabled={preparing}
            style={{
              background: 'none', border: 'none', padding: 0, cursor: preparing ? 'wait' : 'pointer',
              color: 'var(--primary)', fontSize: 12, fontFamily: 'inherit', textDecoration: 'none',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline' }}
            onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none' }}
          >
            {preparing ? 'Preparing…' : 'Download worksheet'}
          </button>
        )}
      </span>
    </div>
  )
}

const linkBtn = {
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  color: 'var(--primary)', fontSize: 'inherit', fontFamily: 'inherit', textDecoration: 'underline',
}

function SkeletonLine({ width, height }) {
  return (
    <div style={{
      width, height, borderRadius: 6,
      background: 'color-mix(in srgb, var(--text) 6%, var(--surface))',
    }} />
  )
}
