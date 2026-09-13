import { useState, useRef, useEffect, useCallback } from 'react'
import { prefersReducedMotion } from '../../styles/shared'
import { TIER_LABEL, tierShapeStyle } from '../../utils/ruleProvenance.js'
import { provenanceDotStyles } from './provenanceDotStyles.js'

// The quiet 6px dot-plus-popover a setup screen shows beside a SINGLE field
// whose value the import worked out rather than the director typing it.
//
// Extracted after a third near-identical copy appeared (T114 division
// provenance, review finding). LocationsScreen had two — capacity provenance
// and the duplicate-name catcher — and GroupsScreen added a third, each one
// re-implementing the same open state, focus return, Escape handler and
// click-outside dismissal, differing only in the sentence inside.
//
// NOT a replacement for ActivitiesScreen's RuleProvenanceDot, which is a
// genuinely different thing: N field rows, per-field disclosure text, and a
// "Change" action that opens a modal. This is the one-field shape, and bending
// one into the other would serve neither.
//
// The body is `children` so each caller keeps its own sentence and its own
// actions — the chrome is what was duplicated, not the content.
export default function ProvenanceDot({
  ariaLabel,
  dialogLabel,
  title,
  tier = 'inferred',
  tierLabel,
  children,
  actions,
}) {
  const [open, setOpen] = useState(false)
  const [hovered, setHovered] = useState(false)
  const btnRef = useRef(null)
  const popRef = useRef(null)
  const reduced = prefersReducedMotion()
  const shape = tierShapeStyle(tier)

  useEffect(() => {
    if (!open) return
    // Focus the first action if there is one, so a keyboard user lands
    // somewhere useful rather than on the dialog container.
    popRef.current?.querySelector('button:not([disabled])')?.focus()
    function onKeyDown(e) { if (e.key === 'Escape') { setOpen(false); btnRef.current?.focus() } }
    function onPointerDown(e) { if (popRef.current && !popRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [open])

  const close = useCallback(() => { setOpen(false); btnRef.current?.focus() }, [])

  return (
    // stopPropagation because these dots sit inside table rows that open an
    // editor on click — reading provenance must never start an edit.
    <span style={{ position: 'relative', display: 'inline-block', marginLeft: 6 }} onClick={(e) => e.stopPropagation()}>
      <button
        ref={btnRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((v) => !v)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        style={{
          ...provenanceDotStyles.dot,
          ...shape,
          boxShadow: hovered ? '0 0 0 3px color-mix(in srgb, var(--text) 10%, transparent)' : shape.boxShadow,
          transition: reduced ? 'none' : 'background-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)',
        }}
      />
      {open && (
        <div ref={popRef} role="dialog" aria-label={dialogLabel} tabIndex={-1} style={provenanceDotStyles.popover}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ ...provenanceDotStyles.rowDot, ...shape }} />
            <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{title}</span>
            {/* Explicit null omits it: the duplicate-name catcher is not a
                provenance TIER, it is a "these two look like the same place"
                notice, and labelling it INFERRED would misdescribe it. */}
            {tierLabel !== null && (
              <span style={provenanceDotStyles.tierLabel}>{tierLabel ?? TIER_LABEL[tier]}</span>
            )}
          </div>
          {children}
          {/* Actions close the popover on their way out, so a caller never has
              to be handed a close function (a render-prop reads a ref during
              render). The caller's own onClick still runs first — this is a
              bubble-phase listener on the wrapper. */}
          {actions && <div style={provenanceDotStyles.rowActions} onClick={close}>{actions}</div>}
        </div>
      )}
    </span>
  )
}
