// T301 slice 2 — one linked-elective bundle's editor: name, period grid,
// division scope, delete. Rendered by OfferingRow (ElectiveSetDetail.jsx)
// inside its own disclosure, one instance per bundle plus a trailing "+ Add
// another bundle" — see that file for the disclosure/list ownership.
//
// CONTROLLED, NOT OPTIMISTIC. Every value shown (name text on mount, which
// periods/tiers are selected) comes from the `bundle` prop, never a local
// mirror the component updates ahead of a write's confirmation — so a failed
// write simply never renders as if it had happened (the standing rule this
// screen family already follows for capacity/minimum). Local state here is
// UI-only: the name field's live edit buffer (matches OfferingRow's own
// capacity/minimum inputs), the save-flash timer, and which control is
// currently mid-write (for the opacity+disabled treatment).
import { useState } from 'react'
import { S, prefersReducedMotion } from '../../styles/shared'
import { useLatestTimeout } from '../../hooks/useLatestTimeout'
import { resolveScope, findBundleOverlap } from './bundleOverlap.js'

const SCOPE_SEGMENTS = [
  { mode: 'all', label: 'All divisions' },
  { mode: 'only', label: 'Only' },
  { mode: 'except', label: 'Except' },
]

const CELL_SEP = String.fromCharCode(0)
const cellKey = (dayId, timeBlockId) => `${dayId}${CELL_SEP}${timeBlockId}`

export default function BundleEditor({
  bundle,
  isDraft,
  activity,
  siblingBundles = [],
  tiers = [],
  days = [],
  timeBlocks = [],
  occurrenceCells = [],
  role,
  onTogglePeriod,
  onSetScopeMode,
  onToggleTier,
  onSaveName,
  onDelete,
}) {
  // Initializer only, matching OfferingRow's capacity/minimum inputs exactly
  // — this editor instance is keyed on the bundle's id by its parent, so a
  // genuinely different bundle remounts a fresh instance rather than reusing
  // this state.
  const [nameText, setNameText] = useState(bundle.name)
  const [savedFlash, setSavedFlash] = useState(false)
  const { start: startSavedFlash } = useLatestTimeout()
  // Which control is mid-write, by an opaque key — NEVER a whole-row lock, so
  // a second click on a DIFFERENT cell is not blocked by the first's pending
  // write.
  const [pendingKeys, setPendingKeys] = useState(() => new Set())

  async function runPending(key, fn) {
    setPendingKeys((prev) => new Set(prev).add(key))
    try {
      await fn()
    } catch {
      // The parent's write function already surfaced the failure through the
      // screen's shared error banner (describeWriteFailure) — nothing to
      // apply here, which is exactly the point: this component's render
      // stays driven by `bundle`, so a failed write leaves it unchanged.
    } finally {
      setPendingKeys((prev) => {
        const next = new Set(prev)
        next.delete(key)
        return next
      })
    }
  }

  function handleCellClick(cell, selected) {
    runPending(`period:${cellKey(cell.day_id, cell.time_block_id)}`, () => onTogglePeriod(bundle, cell, selected))
  }

  function handleScopeClick(mode) {
    if (mode === bundle.scope_mode) return
    runPending('scope', () => onSetScopeMode(bundle, mode))
  }

  function handleTierClick(tierId, selected) {
    runPending(`tier:${tierId}`, () => onToggleTier(bundle, tierId, selected))
  }

  function commitName() {
    if (nameText === bundle.name) return
    runPending('name', async () => {
      await onSaveName(bundle, nameText)
      setSavedFlash(true)
      startSavedFlash(() => setSavedFlash(false), 700)
    })
  }

  const dayOrder = new Map(days.map((d, i) => [d.id, i]))
  const blockOrder = new Map(timeBlocks.map((b, i) => [b.id, i]))
  const dayIds = [...new Set(occurrenceCells.map((c) => c.day_id))]
    .sort((a, b) => (dayOrder.get(a) ?? 0) - (dayOrder.get(b) ?? 0))
  const blockIds = [...new Set(occurrenceCells.map((c) => c.time_block_id))]
    .sort((a, b) => (blockOrder.get(a) ?? 0) - (blockOrder.get(b) ?? 0))
  const cellByKey = new Map(occurrenceCells.map((c) => [cellKey(c.day_id, c.time_block_id), c]))
  const dayLabel = (id) => days.find((d) => d.id === id)?.label ?? days.find((d) => d.id === id)?.name ?? id
  const blockName = (id) => timeBlocks.find((b) => b.id === id)?.name ?? id
  const tierName = (id) => tiers.find((t) => t.id === id)?.name ?? id
  const isSelected = (dayId, timeBlockId) =>
    bundle.periods.some((p) => p.day_id === dayId && p.time_block_id === timeBlockId)

  // THE OVERLAP CHECK — recomputed every render from current props, never
  // "just at the click that caused it": it must APPEAR when a conflicting
  // period is added and RESOLVE when that period (or the sibling's) is
  // removed, and the only way that stays true without extra bookkeeping is
  // deriving it fresh each time, exactly like every other derived value here.
  let overlap = null
  for (const p of bundle.periods) {
    const cell = cellByKey.get(cellKey(p.day_id, p.time_block_id))
    const divisionsAtCell = cell ? [...new Set([...(cell.manual ?? []), ...(cell.generated ?? [])])] : []
    const effectiveDivisions = resolveScope(bundle.scope_mode, bundle.tierIds, divisionsAtCell)
    const found = findBundleOverlap({
      activityId: bundle.activity_id,
      cell: p,
      effectiveDivisions,
      divisionsAtCell,
      siblingBundles,
    })
    if (found) {
      overlap = { ...found, day: p.day_id, timeBlock: p.time_block_id }
      break
    }
  }

  const reduced = prefersReducedMotion()

  return (
    <div
      data-bundle-editor={bundle.id ?? 'draft'}
      style={{
        border: `1.5px solid ${isDraft ? 'var(--border)' : 'var(--border)'}`,
        borderStyle: isDraft ? 'dashed' : 'solid',
        borderRadius: 10,
        padding: 14,
        marginBottom: 10,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10, marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <label style={S.label} htmlFor={`bundle-name-${bundle.id ?? 'draft'}`}>Bundle name</label>
          <input
            id={`bundle-name-${bundle.id ?? 'draft'}`}
            type="text"
            value={nameText}
            placeholder={isDraft ? 'Pick a period below to name this bundle' : undefined}
            disabled={pendingKeys.has('name')}
            onChange={(e) => setNameText(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
            data-saved={savedFlash ? '' : undefined}
            aria-label="Bundle name — a camper's preference sheet must match this text"
            style={{
              ...S.input,
              boxShadow: savedFlash ? '0 0 0 2px var(--secondary)' : undefined,
              opacity: pendingKeys.has('name') ? 0.55 : 1,
              transition: reduced ? 'none' : 'box-shadow var(--motion-base) var(--ease-out)',
            }}
          />
        </div>
        <button
          type="button"
          className="press-97"
          onClick={() => onDelete(bundle)}
          disabled={role !== 'admin'}
          title={role !== 'admin' ? 'Admin only' : undefined}
          style={role !== 'admin' ? { ...S.btnRowDanger, ...S.buttonDisabled } : S.btnRowDanger}
        >
          Delete bundle
        </button>
      </div>

      <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', marginBottom: 8 }}>
        Periods — click to include or remove
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `112px repeat(${dayIds.length}, 86px)`,
          gap: 4,
          marginBottom: 14,
        }}
      >
        <div />
        {dayIds.map((d) => (
          <div key={`col-${d}`} style={{ fontSize: 11, fontWeight: 600, textAlign: 'center', color: 'var(--text-secondary)' }}>
            {dayLabel(d)}
          </div>
        ))}
        {blockIds.flatMap((b) => [
          <div key={`row-${b}`} style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center' }}>
            {blockName(b)}
          </div>,
          ...dayIds.map((d) => {
            const cell = cellByKey.get(cellKey(d, b))
            if (!cell) return <div key={`cell-${b}-${d}`} />
            const selected = isSelected(d, b)
            const key = `period:${cellKey(d, b)}`
            const pending = pendingKeys.has(key)
            const routeNote = cell.manual.length === 0 ? 'Generated only' : cell.generated.length === 0 ? 'Manual only' : null
            return (
              <button
                key={`cell-${b}-${d}`}
                type="button"
                className="press-97"
                disabled={pending}
                aria-pressed={selected}
                aria-label={`${dayLabel(d)}, ${blockName(b)} — ${selected ? 'included, click to remove' : 'click to include'}`}
                onClick={() => handleCellClick({ day_id: d, time_block_id: b }, selected)}
                style={{
                  border: `1.5px solid ${selected ? 'var(--primary)' : 'var(--border)'}`,
                  background: selected ? 'var(--primary)' : 'var(--surface)',
                  color: selected ? '#fff' : 'var(--text)',
                  borderRadius: 6,
                  padding: '6px 4px',
                  fontSize: 11,
                  fontWeight: 600,
                  fontFamily: 'inherit',
                  lineHeight: 1.3,
                  cursor: pending ? 'not-allowed' : 'pointer',
                  opacity: pending ? 0.55 : 1,
                  // Selection itself is instant — no chip toggle in this app
                  // animates its colour swap (DESIGN_STANDARD §8).
                  transition: 'none',
                }}
              >
                {dayLabel(d)} {blockName(b)}
                {routeNote && (
                  <div style={{ fontSize: 9, fontWeight: 500, marginTop: 2, color: selected ? 'color-mix(in srgb, #fff 70%, transparent)' : 'var(--text-secondary)' }}>
                    {routeNote}
                  </div>
                )}
              </button>
            )
          }),
        ])}
      </div>

      <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)', marginBottom: 6 }}>Applies to</div>
      <div style={{ display: 'flex', gap: 0, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)', width: 'fit-content', opacity: pendingKeys.has('scope') ? 0.55 : 1 }}>
        {SCOPE_SEGMENTS.map((seg) => (
          <button
            key={seg.mode}
            type="button"
            aria-pressed={bundle.scope_mode === seg.mode}
            disabled={pendingKeys.has('scope')}
            onClick={() => handleScopeClick(seg.mode)}
            style={S.chip('var(--primary)', bundle.scope_mode === seg.mode, { borderRadius: 0, border: 'none', padding: '6px 14px' })}
          >
            {seg.label}
          </button>
        ))}
      </div>
      <div
        style={{
          overflow: 'hidden',
          maxHeight: bundle.scope_mode !== 'all' ? 200 : 0,
          opacity: bundle.scope_mode !== 'all' ? 1 : 0,
          transition: reduced ? 'none' : 'max-height 140ms var(--ease-out), opacity 140ms var(--ease-out)',
          marginTop: bundle.scope_mode !== 'all' ? 10 : 0,
        }}
      >
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
          {bundle.scope_mode === 'except' ? 'Except these divisions:' : 'Only these divisions:'}
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {tiers.map((t) => {
            const selected = bundle.tierIds.includes(t.id)
            return (
              <button
                key={t.id}
                type="button"
                className="press-97"
                aria-pressed={selected}
                disabled={pendingKeys.has(`tier:${t.id}`)}
                onClick={() => handleTierClick(t.id, selected)}
                style={{ ...S.chip('var(--primary)', selected), opacity: pendingKeys.has(`tier:${t.id}`) ? 0.55 : 1 }}
              >
                {t.name}
              </button>
            )
          })}
        </div>
      </div>

      {overlap && (
        <div
          style={{
            ...S.cautionBanner,
            marginTop: 12,
            marginBottom: 0,
            transition: reduced ? 'none' : 'opacity 220ms var(--ease-out), transform 220ms var(--ease-out)',
          }}
        >
          <strong>Overlaps another {activity?.name ?? 'activity'} bundle</strong> — &ldquo;{overlap.bundleName}&rdquo; also
          claims {dayLabel(overlap.day)}, {blockName(overlap.timeBlock)} for {overlap.divisionIds.map(tierName).join(' and ')}.
          A camper eligible for both can&rsquo;t be placed in either — the schedule generator will fall back to placing
          them period-by-period instead. You can still save this.
        </div>
      )}
    </div>
  )
}
