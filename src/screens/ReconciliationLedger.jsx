import { useState } from 'react'
import { S } from '../styles/shared'
import { fieldLabel } from '../ingest/fieldLabels'
import { CLEAR } from '../ingest/buildPlan'

// S5b — the reconciliation-preview LEDGER (T75). The "nothing is saved until you
// commit" surface BOTH import paths (schedule + workbook) share, shown BEFORE
// commit. Design: docs/work/onboarding-reconciliation/S5-READINESS-HUB-DESIGN.md §7.
//
// Ledger-first, exception-expanded: the reassuring majority (Unchanged) collapses
// to a count; Updated/New/Clear are readable at a glance; Conflict/ambiguous
// auto-expand and GATE the commit (nothing commits while an unresolved conflict
// stands — commitIngest would re-hold them anyway; here we say so up front).
//
// The ledger holds NO domain state — it renders the pure ReconciliationPlan diff
// and owns only which collapsed sections are open. The commit re-runs buildPlan
// verbatim, so preview and commit agree (Article V).

// A value rendered for the director. The CLEAR sentinel becomes an explicit
// "(cleared)" — the absence is stated, never left blank (spec §7.4).
function fmtVal(v) {
  if (v === CLEAR) return '(cleared)'
  if (v === null || v === undefined || v === '') return '(empty)'
  if (Array.isArray(v)) return v.length ? v.join(', ') : '(none)'
  return String(v)
}

// muted was → full will-be (spec §7.3). Only changed fields render.
function FieldDiff({ field, delta }) {
  const cleared = delta.to === CLEAR
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 6, fontSize: 12, lineHeight: 1.6 }}>
      <span style={{ color: 'var(--text-secondary)', minWidth: 150 }}>{fieldLabel(field)}</span>
      <span style={{ color: 'var(--text-secondary)' }}>{fmtVal(delta.from)}</span>
      <span style={{ color: 'var(--accent)', margin: '0 2px' }}>→</span>
      <span style={{ color: cleared ? 'var(--text-secondary)' : 'var(--text)', fontStyle: cleared ? 'italic' : 'normal', fontWeight: cleared ? 400 : 600 }}>
        {fmtVal(delta.to)}
      </span>
    </div>
  )
}

// One ledger section: glyph + count + word header, an optional [show]/[hide]
// disclosure, and its rows. `collapsible` sections start collapsed (rows hidden,
// the count IS the reassurance); `open` sections always render their rows.
function LedgerSection({ glyph, color, word, items, collapsible, defaultOpen = false, renderItem, firmerNote }) {
  const [open, setOpen] = useState(defaultOpen)
  if (items.length === 0) return null
  const shown = collapsible ? open : true
  return (
    <div style={{ padding: '10px 0', borderBottom: '1px solid color-mix(in srgb, var(--border) 60%, transparent)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ color, fontWeight: 700, fontSize: 12, width: 14, textAlign: 'center' }}>{glyph}</span>
        <span style={{ fontSize: 13, color: 'var(--text)', flex: 1, fontWeight: 600 }}>
          {`${items.length} ${word}`}
        </span>
        {collapsible && (
          <button
            className="press-97"
            onClick={() => setOpen((v) => !v)}
            style={{ ...S.btnSecondary, padding: '2px 8px', fontSize: 11, background: 'none', border: 'none', color: 'var(--primary)' }}
          >
            {open ? 'hide' : 'show'}
          </button>
        )}
      </div>
      {firmerNote && shown && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '6px 0 8px 22px', lineHeight: 1.6 }}>
          {firmerNote}
        </div>
      )}
      {shown && (
        <div style={{ marginTop: 8, marginLeft: 22, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.map((it, i) => (
            <div key={`${it.entity}-${it._name}-${i}`}>{renderItem(it)}</div>
          ))}
        </div>
      )}
    </div>
  )
}

const recordName = (it) => it._name

export function ReconciliationLedger({ plan, fileName, working, onCommit, onDiscard }) {
  const items = plan?.items ?? []
  const by = { create: [], update: [], unchanged: [], clear: [], conflict: [] }
  for (const it of items) (by[it.op] ?? (by[it.op] = [])).push(it)

  const conflicts = by.conflict
  const hasConflicts = conflicts.length > 0
  const committable = items.length - conflicts.length

  const nothingToDo = committable === 0 && !hasConflicts

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10,
      padding: '16px 18px', marginBottom: 16,
      animation: 'importCardIn var(--motion-settle) var(--ease-out)',
    }}>
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', marginBottom: 2 }}>
        Nothing is saved yet — here’s what this import would do
      </div>
      {fileName && (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)', marginBottom: 12 }}>
          Reviewing {fileName}
        </div>
      )}

      {nothingToDo && (
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 12 }}>
          Everything in this file already matches your camp. Nothing would change.
        </div>
      )}

      {/* Reassurance first, exceptions last (spec §7.2). */}
      <LedgerSection
        glyph="✓" color="var(--success)" word="unchanged"
        items={by.unchanged} collapsible
        renderItem={(it) => <span style={{ fontSize: 13, color: 'var(--text)' }}>{recordName(it)}</span>}
      />

      <LedgerSection
        glyph="✓" color="var(--success)" word="updated"
        items={by.update} defaultOpen
        renderItem={(it) => (
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>{recordName(it)}</div>
            {Object.entries(it.fields).map(([f, d]) => <FieldDiff key={f} field={f} delta={d} />)}
          </div>
        )}
      />

      {/* Clear is firmer than an update — its own line, never folded in (spec §7.4). */}
      <LedgerSection
        glyph="⌫" color="var(--accent)" word="cleared"
        items={by.clear}
        firmerNote="These remove a value. Confirm you meant to clear them."
        renderItem={(it) => (
          <div style={{
            padding: '8px 10px', borderRadius: 6,
            background: 'color-mix(in srgb, var(--accent) 6%, var(--surface))',
            border: '1px solid color-mix(in srgb, var(--accent) 40%, var(--border))',
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>{recordName(it)}</div>
            {Object.entries(it.fields).map(([f, d]) => <FieldDiff key={f} field={f} delta={d} />)}
          </div>
        )}
      />

      <LedgerSection
        glyph="+" color="var(--success)" word="new"
        items={by.create} collapsible
        renderItem={(it) => <span style={{ fontSize: 13, color: 'var(--text)' }}>{recordName(it)}</span>}
      />

      {/* Needs-attention: auto-expanded, always, and it gates the commit (spec §7.2). */}
      {hasConflicts && (
        <div style={{ padding: '10px 0', borderBottom: '1px solid color-mix(in srgb, var(--border) 60%, transparent)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ color: 'var(--accent)', fontWeight: 700, fontSize: 12, width: 14, textAlign: 'center' }}>!</span>
            <span style={{ fontSize: 13, color: 'var(--text)', flex: 1, fontWeight: 600 }}>
              {`${conflicts.length} need your attention`} — commit is held until {conflicts.length === 1 ? 'this is' : 'these are'} resolved
            </span>
          </div>
          <div style={{ marginTop: 8, marginLeft: 22, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {conflicts.map((it, i) => (
              <div key={`c-${it._name}-${i}`} style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.6 }}>
                <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--accent)', marginRight: 6 }}>
                  {it.reason === 'ambiguous_identity' ? '≟' : '⚠'}
                </span>
                {it.reason === 'ambiguous_identity'
                  ? <>“{it._name}” — is this the same as one you already have?</>
                  : it.reason === 'missing_target'
                    ? <>“{it._name}” — points at a record that’s no longer here.</>
                    : <>“{it._name}” — {String(it.reason).replace(/_/g, ' ')}.</>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Commit and discard (spec §7.6). The commit is the ONLY write; it is the
          existing atomic ingestCommit. Held-until-resolved when conflicts stand. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
        <button
          className="press-97"
          onClick={onCommit}
          disabled={working || hasConflicts || nothingToDo}
          style={{ ...S.btnPrimary, opacity: working || hasConflicts || nothingToDo ? 0.45 : 1 }}
        >
          {working
            ? 'Committing…'
            : hasConflicts
              ? `Held until ${conflicts.length} resolved`
              : `Commit ${committable} ${committable === 1 ? 'record' : 'records'}`}
        </button>
        {hasConflicts && (
          <button className="press-97" onClick={onCommit} disabled={working} style={S.btnPrimary}>
            Review the {conflicts.length} {conflicts.length === 1 ? 'item' : 'items'}
          </button>
        )}
        <button className="press-97" onClick={onDiscard} disabled={working} style={S.btnSecondary}>
          Discard
        </button>
      </div>
    </div>
  )
}
