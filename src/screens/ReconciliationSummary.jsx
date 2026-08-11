import { S } from '../styles/shared'

// D1 — the read-only reconciliation summary, the PRIMARY post-import
// destination (docs/work/specs/mockups/2026-08-10-phaseD-reconciliation/).
// Renders a `buildReconciliationReport` output: four buckets, a readiness-
// derived category strip, and a single (D1: no-op) "Review N decisions" CTA.
// Decision cards/resolution are D2 — this component never mutates anything.
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

export function ReconciliationSummary({ report, readiness = [] }) {
  const buckets = report?.buckets ?? { understood: 0, needsAttention: 0, notInSource: 0, changed: 0 }
  const decisionCount = report?.decisions?.length ?? 0

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
      padding: '20px 22px', marginBottom: 16,
      animation: 'importCardIn var(--motion-settle) var(--ease-out)',
    }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', marginBottom: 16 }}>
        Shoresh reconstructed your camp from this source.
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

      <div style={{ display: 'flex', gap: 10, marginTop: 20, alignItems: 'center' }}>
        {/* D1 placeholder — decision cards/resolution are D2. This button is a
            deliberate no-op until then; it stays visible so the CTA's presence
            (and count) is truthful from the first ship. */}
        <button
          className="press-97"
          disabled
          title="Decision review lands in a follow-up slice"
          style={{ ...S.btnPrimary, opacity: 0.5, cursor: 'default' }}
        >
          Review {decisionCount} decision{decisionCount === 1 ? '' : 's'}
        </button>
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
