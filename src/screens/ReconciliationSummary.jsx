import { S } from '../styles/shared'

// D1 — the read-only reconciliation summary, the PRIMARY post-import
// destination (docs/work/specs/mockups/2026-08-10-phaseD-reconciliation/).
// Renders a `buildReconciliationReport` output: four buckets, a readiness-
// derived category strip, and a CTA row. Decision cards/resolution are D2 —
// this component never mutates anything.
//
// Round 2 (Tester UX finding): a disabled "Review N decisions" primary CTA
// read as broken — the director stared at a dead-end with no forward path.
// The real D1 working path is the ReconciliationLedger/commit rendered right
// below this summary, so the CTA row now leads there explicitly: a real,
// working primary ("Review & commit below", via onReviewBelow) plus the
// per-decision review kept as a plainly-secondary, honestly-labeled
// "coming in a later update" affordance — never a dead primary.
//
// Glyph/colour vocabulary is reused verbatim from ReconciliationLedger.jsx
// (✓ --success, ⌫/+ --success, and here ⚠ --accent, ↻ --danger, ○ --anchor) —
// nothing invented here.

const BUCKET_ROWS = [
  { key: 'understood', glyph: '✓', color: 'var(--success)', label: 'understood — facts reconciled without a question' },
  { key: 'needsAttention', glyph: '⚠', color: 'var(--accent)', label: 'need your attention' },
  { key: 'notInSource', glyph: '○', color: 'var(--anchor)', label: 'optional areas not in this source' },
  { key: 'changed', glyph: '↻', color: 'var(--danger)', label: "changed from what's already set up" },
]

// readiness.js's REQUIRED_AREAS/OPTIONAL_AREAS/FORWARD_AREAS keys, grouped
// into the four screen categories the mockup shows — not an invented
// taxonomy, just a display grouping of the real category spine.
const CATEGORY_GROUPS = [
  { label: 'Structure — Groups, Units, Days', keys: ['groups', 'tiers', 'days'] },
  { label: 'Scheduling model — Activities, Fixed events', keys: ['activities', 'anchors'] },
  { label: 'Time — Time blocks', keys: ['timeblocks'] },
  { label: 'Resources — Locations, Staffing', keys: ['location', 'staffing'] },
]

const CHIP_DOT_COLOR = { ok: 'var(--success)', attn: 'var(--accent)', gap: 'var(--anchor)' }

function chipState(readiness, keys) {
  const rows = readiness.filter((r) => keys.includes(r.key))
  if (rows.some((r) => r.state === 'missing' || r.state === 'needs-attention' || r.state === 'in-progress')) return 'attn'
  if (rows.length > 0 && rows.every((r) => r.state === 'optional' || r.state === 'not-applicable')) return 'gap'
  return 'ok'
}

export function ReconciliationSummary({ report, readiness = [], onReviewBelow, onReviewDecisions }) {
  const buckets = report?.buckets ?? { understood: 0, needsAttention: 0, notInSource: 0, changed: 0 }
  const decisionCount = report?.decisions?.length ?? 0

  return (
    <div style={{
      background: 'var(--surface-elevated)', border: '1px solid var(--border)', borderRadius: 10,
      padding: '20px 22px', marginBottom: 16, boxShadow: '0 1px 2px rgba(30,42,52,.04)',
      animation: 'importCardIn var(--motion-settle) var(--ease-out)',
    }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', marginBottom: 16 }}>
        {/* Round 2 (Red Hat MEDIUM): a sync Client's summary is computed from
            this device's possibly-stale local replica, not a single ground
            truth for the whole camp — the copy now speaks about this source
            and this device's view, not an absolute reconstruction. */}
        Here's what Shoresh found in this source, based on this device's current view of your camp.
      </div>

      {BUCKET_ROWS.map((b) => (
        <div
          key={b.key}
          style={{
            display: 'flex', alignItems: 'baseline', gap: 12, padding: '9px 0',
            borderBottom: '1px solid color-mix(in srgb, var(--border) 60%, transparent)',
          }}
        >
          <span style={{ width: 18, textAlign: 'center', fontSize: 13, color: b.color }}>{b.glyph}</span>
          <span style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums', minWidth: 28, color: b.color }}>
            {buckets[b.key] ?? 0}
          </span>
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{b.label}</span>
        </div>
      ))}

      <div style={{ display: 'flex', gap: 10, marginTop: 20, alignItems: 'center', flexWrap: 'wrap' }}>
        {/* The real, working D1 path: the ReconciliationLedger + commit sit
            directly below this summary. A real primary points there instead
            of dead-ending on a disabled button. */}
        <button className="press-97" onClick={onReviewBelow} style={S.btnPrimary}>
          Review &amp; commit below
        </button>
        {/* D2 — per-decision review is now real. Kept plainly secondary
            (never a second primary) but a working button, not dead text. */}
        {onReviewDecisions && decisionCount > 0 ? (
          <button className="press-97" onClick={onReviewDecisions} style={S.btnSecondary}>
            Review {decisionCount} decision{decisionCount === 1 ? '' : 's'}
          </button>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            Reviewing {decisionCount} decision{decisionCount === 1 ? '' : 's'} one at a time is coming in a later update.
          </span>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
        {CATEGORY_GROUPS.map((g) => {
          const state = chipState(readiness, g.keys)
          return (
            <span
              key={g.label}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px', borderRadius: 20,
                background: 'var(--bg)', border: '1px solid var(--border)', fontSize: 12, fontWeight: 600,
                color: 'var(--text-secondary)',
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: CHIP_DOT_COLOR[state] }} />
              {g.label}
            </span>
          )
        })}
      </div>
    </div>
  )
}
