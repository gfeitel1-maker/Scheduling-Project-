// Shared inline style constants — import as: import { S } from '../styles/shared'
import { useState, useEffect } from 'react'

// Reduced-motion fallbacks for inline-styled elements are read via
// matchMedia at render time; global motion primitives live in src/index.css.
export function prefersReducedMotion() {
  return typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
}

/**
 * Mount transition for inline-styled elements. Returns a style fragment to
 * spread onto the animated element. Renders one frame in the "from" state,
 * then flips to the "to" state on the next animation frame.
 *
 * variant:
 *   'slideFade' — translateY(-4px)->0 + opacity 0->1, --motion-base   (§5c error banners)
 *   'liftFade'  — translateY(8px)->0  + opacity 0->1, --motion-base   (modals)
 *   'settle'    — translateY(12px)->0 + opacity 0->1, --motion-settle (blocking gates, m3-locations §5d)
 *   'popFade'   — scale(0.97)->1      + opacity 0->1, 180ms           (anchored popovers)
 *
 * Under prefers-reduced-motion the transform is dropped entirely and only
 * opacity crossfades, per DESIGN_STANDARD §8.
 */
export function useEnterTransition(variant, { transformOrigin } = {}) {
  const reduced = prefersReducedMotion()
  const [entered, setEntered] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(id)
  }, [])

  const FROM = {
    slideFade: 'translateY(-4px)',
    liftFade: 'translateY(8px)',
    settle: 'translateY(12px)',
    popFade: 'scale(0.97)',
  }
  const DURATION = variant === 'popFade' ? '180ms' : variant === 'settle' ? 'var(--motion-settle)' : 'var(--motion-base)'

  if (reduced) {
    return {
      opacity: entered ? 1 : 0,
      transition: `opacity ${DURATION} var(--ease-out)`,
    }
  }
  return {
    opacity: entered ? 1 : 0,
    transform: entered ? 'none' : FROM[variant],
    transformOrigin,
    transition: `opacity ${DURATION} var(--ease-out), transform ${DURATION} var(--ease-out)`,
  }
}

export const S = {
  btnPrimary: {
    padding: '7px 14px',
    background: 'var(--primary)',
    color: '#fff',
    border: 'none',
    borderRadius: 7,
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  btnSecondary: {
    padding: '7px 14px',
    background: 'var(--surface)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
    borderRadius: 7,
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  buttonDisabled: {
    opacity: 0.45,
    cursor: 'not-allowed',
  },
  btnDanger: {
    padding: '7px 14px',
    background: 'none',
    color: 'var(--warning)',
    border: '1px solid var(--warning)',
    borderRadius: 7,
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  backBar: {
    background: 'none',
    border: 'none',
    padding: '4px 6px',
    marginLeft: -6,
    fontSize: 13,
    color: 'var(--text-secondary)',
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  th: {
    padding: '10px 14px',
    textAlign: 'left',
    fontSize: 12,
    fontFamily: 'var(--font-condensed)',
    fontWeight: 500,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  td: {
    padding: '10px 14px',
    textAlign: 'left',
    fontSize: 13,
  },
  input: {
    padding: '8px 10px',
    border: '1.5px solid var(--border)',
    borderRadius: 7,
    fontSize: 13,
    outline: 'none',
    background: 'var(--surface)',
    width: '100%',
    fontFamily: 'inherit',
  },
  label: {
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--text-secondary)',
    display: 'block',
    marginBottom: 4,
  },
  modalSm: {
    background: 'var(--surface-elevated)',
    borderRadius: 12,
    padding: 28,
    maxWidth: 400,
    width: '100%',
  },
  modalLg: {
    background: 'var(--surface-elevated)',
    borderRadius: 12,
    padding: 28,
    width: 480,
    maxWidth: '100%',
    maxHeight: '90vh',
    overflowY: 'auto',
  },
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.45)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: 16,
  },
  // Import-preview warning row — replaces the hardcoded #FFF8E7 / #F5A623
  // literals previously pasted into every setup screen's import table.
  importWarnRow: {
    background: 'color-mix(in srgb, var(--warning) 12%, var(--surface))',
  },
  importWarnText: {
    color: 'var(--warning)',
    fontFamily: 'var(--font-mono)',
    fontSize: 12,
  },
  errorBanner: {
    background: 'color-mix(in srgb, var(--danger) 8%, var(--surface))',
    border: '1px solid color-mix(in srgb, var(--danger) 35%, var(--border))',
    borderRadius: 6,
    padding: '10px 14px',
    marginBottom: 16,
    fontSize: 13,
    color: 'var(--danger)',
  },
  // Advisory/caution copy (e.g. "set this up first") — bronze --accent per
  // DESIGN_STANDARD §4, never a separately-named amber.
  cautionBanner: {
    background: 'color-mix(in srgb, var(--accent) 12%, var(--surface))',
    border: '1px solid color-mix(in srgb, var(--accent) 45%, var(--border))',
    borderRadius: 6,
    padding: '10px 14px',
    marginBottom: 16,
    fontSize: 13,
    color: 'color-mix(in srgb, var(--accent) 65%, var(--text))',
  },

  // --- Auth / onboarding shared primitives ---
  authPage: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    background: 'var(--bg)',
    padding: 24,
    boxSizing: 'border-box',
  },
  authCard: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    padding: '40px 44px',
    maxWidth: 460,
    width: '100%',
    boxShadow: '0 2px 24px color-mix(in srgb, var(--text) 6%, transparent)',
    boxSizing: 'border-box',
  },
  authLogoBlock: {
    marginBottom: 28,
    textAlign: 'left',
  },
  authLogo: {
    fontFamily: 'var(--font-condensed)',
    fontWeight: 700,
    fontSize: 28,
    color: 'var(--primary)',
    letterSpacing: '-0.5px',
  },
  authLogoSub: {
    fontSize: 11,
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-secondary)',
    marginTop: 2,
  },
  authEyebrow: {
    fontFamily: 'var(--font-condensed)',
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    color: 'var(--text-secondary)',
    marginBottom: 6,
  },
  authTitle: {
    fontFamily: 'var(--font-condensed)',
    fontWeight: 700,
    fontSize: 22,
    color: 'var(--text)',
    letterSpacing: '-0.3px',
    marginBottom: 8,
  },
  authSubtitle: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    lineHeight: 1.6,
    marginBottom: 26,
  },
  authField: {
    width: '100%',
    padding: '10px 12px',
    border: '1.5px solid var(--border)',
    borderRadius: 7,
    fontSize: 14,
    fontFamily: 'inherit',
    outline: 'none',
    background: 'var(--bg)',
    color: 'var(--text)',
    boxSizing: 'border-box',
  },
  authLabel: {
    fontSize: 12,
    fontWeight: 500,
    display: 'block',
    marginBottom: 5,
    marginTop: 16,
    color: 'var(--text-secondary)',
  },
  authHint: {
    fontSize: 11,
    color: 'var(--text-secondary)',
    marginTop: 5,
  },
  authBtnPrimary: {
    display: 'block',
    width: '100%',
    padding: '11px 0',
    background: 'var(--primary)',
    color: '#fff',
    border: 'none',
    borderRadius: 7,
    fontWeight: 700,
    fontSize: 14,
    cursor: 'pointer',
    fontFamily: 'inherit',
    marginTop: 22,
  },
  authLinkBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-secondary)',
    fontSize: 12,
    cursor: 'pointer',
    padding: 0,
    fontFamily: 'inherit',
    textDecoration: 'underline',
  },
  authBackRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 18,
  },
  authBackBtn: {
    background: 'none',
    border: 'none',
    color: 'var(--text-secondary)',
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
    padding: '4px 6px',
    marginLeft: -6,
    borderRadius: 5,
  },
  authErrorBox: {
    background: 'color-mix(in srgb, var(--danger) 7%, var(--surface))',
    border: '1px solid color-mix(in srgb, var(--danger) 30%, var(--border))',
    borderRadius: 7,
    padding: '10px 12px',
    fontSize: 12,
    color: 'var(--danger)',
    marginBottom: 14,
    display: 'flex',
    gap: 8,
    alignItems: 'flex-start',
  },
  // Informational, not a failure the user caused — a bounce back to login
  // that the user didn't choose (session ended, or the Host revoked the
  // device). Uses --accent (the caution hue) rather than --danger so it
  // reads as "here's what happened," not an error the director triggered.
  authNoticeBox: {
    background: 'color-mix(in srgb, var(--accent) 7%, var(--surface))',
    border: '1px solid color-mix(in srgb, var(--accent) 30%, var(--border))',
    borderRadius: 7,
    padding: '10px 12px',
    fontSize: 12,
    color: 'color-mix(in srgb, var(--accent) 60%, var(--text))',
    marginBottom: 14,
    display: 'flex',
    gap: 8,
    alignItems: 'flex-start',
  },
  authChoiceCard: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 14,
    padding: '18px 18px',
    background: 'var(--surface)',
    border: '1.5px solid var(--border)',
    borderRadius: 10,
    textAlign: 'left',
    cursor: 'pointer',
    width: '100%',
    marginBottom: 12,
    transition: 'box-shadow var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out)',
    fontFamily: 'inherit',
  },
  authChoiceIcon: {
    width: 38,
    height: 38,
    borderRadius: 9,
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'color-mix(in srgb, var(--primary) 10%, transparent)',
    color: 'var(--primary)',
    fontSize: 18,
  },
  authChoiceTitle: {
    fontFamily: 'var(--font-condensed)',
    fontWeight: 700,
    fontSize: 15,
    color: 'var(--text)',
    marginBottom: 3,
  },
  authChoiceDesc: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    lineHeight: 1.5,
  },
  authChoiceChevron: {
    marginLeft: 'auto',
    alignSelf: 'center',
    color: 'var(--text-secondary)',
    fontSize: 15,
    paddingLeft: 8,
  },
  authHostItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '13px 14px',
    border: '1.5px solid var(--border)',
    borderRadius: 8,
    marginBottom: 8,
    cursor: 'pointer',
    transition: 'border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)',
    background: 'var(--surface)',
    width: '100%',
    textAlign: 'left',
    fontFamily: 'inherit',
  },
  authHostDot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    background: 'var(--success)',
    flexShrink: 0,
    boxShadow: '0 0 0 3px color-mix(in srgb, var(--success) 18%, transparent)',
  },
  authHostName: {
    fontWeight: 600,
    fontSize: 13.5,
    color: 'var(--text)',
  },
  authHostMeta: {
    fontSize: 11,
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-secondary)',
    marginTop: 1,
  },
  authRolePill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    fontFamily: 'var(--font-mono)',
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: 99,
    padding: '3px 9px',
    marginBottom: 18,
  },
  authLockoutBox: {
    textAlign: 'center',
    padding: '18px 14px',
    background: 'color-mix(in srgb, var(--accent) 8%, var(--surface))',
    border: '1px solid color-mix(in srgb, var(--accent) 32%, var(--border))',
    borderRadius: 8,
    marginTop: 16,
  },
  authLockoutTitle: {
    fontFamily: 'var(--font-condensed)',
    fontWeight: 700,
    fontSize: 14,
    color: 'color-mix(in srgb, var(--accent) 60%, var(--text))',
    marginBottom: 4,
  },
  authLockoutDesc: {
    fontSize: 12,
    color: 'color-mix(in srgb, var(--accent) 60%, var(--text))',
    lineHeight: 1.5,
  },
  authLockoutTimer: {
    fontFamily: 'var(--font-mono)',
    fontWeight: 700,
    fontSize: 15,
    color: 'color-mix(in srgb, var(--accent) 60%, var(--text))',
    marginTop: 8,
  },

  // --- Schedule grid editing ---
  pasteStatusLine: {
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '6px 12px',
    background: 'var(--surface-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 7,
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    color: 'var(--text-secondary)',
    marginBottom: 8,
  },
  pasteStatusLineError: {
    color: 'var(--warning)',
    borderColor: 'color-mix(in srgb, var(--warning) 35%, var(--border))',
  },
  // Selection moves off navy (navy is reserved for DnD drop-target chrome) —
  // elevation is a channel nothing else on the grid uses. See
  // docs/superpowers/specs/2026-07-28-schedule-grid-decolorization-design.md §8-9.
  cellSelected: {
    boxShadow: '0 2px 8px color-mix(in srgb, var(--text) 18%, transparent)',
    outline: '1.5px solid var(--text)',
    outlineOffset: -1,
    transform: 'translateY(-1px)',
    transition: 'transform var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out)',
  },
  cellMultiSelectedFill: {
    background: 'color-mix(in srgb, var(--text) 6%, var(--surface))',
  },

  // --- Schedule grid cell states (2026-07-28 decolorization pass) ---
  cellIdentityChip: {
    width: 6,
    height: 6,
    borderRadius: '50%',
    display: 'inline-block',
    marginRight: 4,
    verticalAlign: 'middle',
    flexShrink: 0,
  },
  cellStructuralBar: accentVar => ({
    // used for both anchor (--anchor) and locked (--accent); pass the token string
    borderLeft: `3px solid ${accentVar}`,
    borderTop: '1px solid var(--border)',
    borderRight: '1px solid var(--border)',
    borderBottom: '1px solid var(--border)',
  }),
  cellUnfillableBar: {
    borderLeft: '4px solid var(--danger)',
    borderTop: '1px solid var(--border)',
    borderRight: '1px solid var(--border)',
    borderBottom: '1px solid var(--border)',
    background: 'color-mix(in srgb, var(--danger) 6%, var(--surface))',
  },
  cellUnavailableFill: {
    background: 'color-mix(in srgb, var(--text) 5%, var(--bg))',
    border: '1px solid var(--border)',
  },
  cellEmptyOutline: {
    background: 'var(--surface)',
    border: '1.5px dashed var(--border)',
  },
  cellOutdoorIconStyle: {
    position: 'absolute',
    top: 3,
    right: 3,
    fontSize: 10,
    color: 'var(--text-secondary)',
    lineHeight: 1,
    pointerEvents: 'none',
  },
  cellUnfillableIconStyle: {
    position: 'absolute',
    top: 4,
    right: 4,
    width: 12,
    height: 12,
    color: 'var(--danger)',
  },

  // A cell lit up because a concern box is active (the generated "track
  // changes" review). ONE treatment, parameterised only by the concern's
  // colour, so a director learns the pattern once — a full outline plus a faint
  // tint, distinct from selection (which lifts) and from the structural bars
  // (which are a left edge). docs/work/specs/2026-08-01-generated-flag-review.md
  cellFlagHighlight: color => ({
    outline: `1.5px solid ${color}`,
    outlineOffset: -1,
    background: `color-mix(in srgb, ${color} 10%, var(--surface))`,
  }),
  // The reason callout that appears when a lit cell is hovered or focused.
  // Anchored above the cell; fades via opacity so it doesn't jump.
  cellReasonCallout: {
    position: 'absolute',
    bottom: 'calc(100% + 4px)',
    left: 0,
    zIndex: 30,
    minWidth: 160,
    maxWidth: 240,
    padding: '6px 9px',
    background: 'var(--surface-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    boxShadow: '0 2px 16px color-mix(in srgb, var(--text) 10%, transparent)',
    fontSize: 11,
    fontWeight: 500,
    lineHeight: 1.35,
    color: 'var(--text)',
    whiteSpace: 'normal',
    pointerEvents: 'none',
  },

  // Findings & Flags rail (popover under header badge)
  findingsRailPanel: {
    position: 'absolute',
    background: 'var(--surface-elevated)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    boxShadow: '0 2px 24px color-mix(in srgb, var(--text) 6%, transparent)',
    maxWidth: 360,
    maxHeight: 400,
    overflowY: 'auto',
    zIndex: 20,
  },
  findingsRailRow: severityColor => ({
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    padding: '8px 10px',
    borderLeft: `3px solid ${severityColor}`,
    borderBottom: '1px solid var(--border)',
    fontSize: 13,
    color: 'var(--text)',
  }),
  cellActionBtn: {
    position: 'absolute', top: 4, right: 4,
    width: 16, height: 16,
    borderRadius: 4,
    border: '1px solid var(--border)',
    background: 'var(--surface-elevated)',
    cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 10,
    color: 'var(--text-secondary)',
    zIndex: 3,
    padding: 0,
    fontFamily: 'inherit',
  },

  // --- Merge / conflict resolution (ConflictsScreen) ---
  mergeCard: {
    background: 'var(--surface)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--border)',
    borderRadius: 12,
    padding: '18px 20px',
    marginBottom: 14,
    overflow: 'hidden',
    transition: 'max-height var(--motion-settle) var(--ease-out), opacity var(--motion-settle) var(--ease-out), margin var(--motion-settle) var(--ease-out), padding var(--motion-settle) var(--ease-out), border-color var(--motion-settle) var(--ease-out)',
  },
  mergeChoiceBox: {
    flex: 1,
    minWidth: 220,
    background: 'var(--bg)',
    borderWidth: 1.5,
    borderStyle: 'solid',
    borderColor: 'var(--border)',
    borderRadius: 9,
    padding: 14,
    transition: 'border-color var(--motion-fast) var(--ease-out)',
  },
  mergeChoiceBoxHover: {
    borderColor: 'var(--primary)',
  },
  mergeMeta: {
    fontSize: 11.5,
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-secondary)',
  },
  mergeBtnKeep: {
    padding: '7px 14px',
    background: 'var(--surface)',
    color: 'var(--text)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'var(--border)',
    borderRadius: 7,
    fontWeight: 600,
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
    width: '100%',
    marginTop: 12,
    transition: 'background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out)',
  },
  mergePinLock: {
    textAlign: 'center',
    padding: '10px 0',
    color: 'var(--text-secondary)',
    fontSize: 13,
  },
  emptyStateTall: {
    padding: '60px 16px',
    textAlign: 'center',
  },
  mergeConfirmed: {
    textAlign: 'center',
    padding: '20px 0',
    color: 'var(--success)',
    fontFamily: 'var(--font-condensed)',
    fontWeight: 700,
    fontSize: 15,
    transition: 'opacity var(--motion-fast) var(--ease-out)',
  },

  // --- Empty / loading / error state primitives ---
  stateLoading: {
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-mono)',
    fontSize: 13,
  },
  emptyState: {
    padding: '40px 16px',
    textAlign: 'center',
  },
  emptyStateTitle: {
    fontFamily: 'var(--font-condensed)',
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    marginBottom: 4,
  },
  emptyStateTitleLarge: {
    fontFamily: 'var(--font-condensed)',
    fontSize: 20,
    fontWeight: 600,
    color: 'var(--text)',
    marginBottom: 8,
  },
  emptyStateBody: {
    fontSize: 12,
    color: 'var(--text-secondary)',
  },
  // --- Chips / pills (colored fill + white text) ---
  // The "colored pill, white text" shape used by toggleable filter chips
  // (group/day pickers, reconciliation decision chips) and static status
  // badges (device authorization, activity priority tags). `selected`
  // switches between the filled/on look and the surface/off look; overrides
  // tune radius/padding/size per call site without re-deriving the fill
  // logic. This is the one place #fff is allowed as a chip text color.
  chip: (color, selected, overrides = {}) => ({
    borderRadius: 20,
    padding: '5px 12px',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: 'inherit',
    cursor: 'pointer',
    border: `1.5px solid ${selected ? color : 'var(--border)'}`,
    background: selected ? color : 'var(--surface)',
    color: selected ? '#fff' : 'var(--text)',
    ...overrides,
  }),

  // Uppercase condensed section-header label used above an inline "Add X"
  // form (Tiers/Groups/Days/TimeBlocks/Electives/Locations/Events). Forked
  // byte-identically across those screens before Wave 3 consolidated it.
  sectionLabel: {
    fontFamily: 'var(--font-condensed)',
    fontWeight: 700,
    fontSize: 13,
    marginBottom: 10,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },

  // Text-secondary variant of S.sectionLabel used for the small-caps section
  // count header ("3 GROUPS", "5 DAYS", "4 BLOCKS") above setup-screen lists.
  // Same condensed/700/13px/uppercase treatment, no marginBottom, muted color.
  // Consolidated from a local `eyebrow` object in SetupScreenShell plus
  // byte-identical inline copies in Locations/Cohorts (Wave B2).
  sectionCount: {
    fontFamily: 'var(--font-condensed)',
    fontWeight: 700,
    fontSize: 13,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },

  // W12b (docs/work/specs/2026-08-22-brand-placement-round2.md §3) — optional
  // icon slot for S.emptyState. Sits directly on the page/table background,
  // no card, matching DESIGN_STANDARD §5a's "calm, not boxed" rule for
  // emptiness. Proportional to the sliced ui-*.png tiles' 307.2:256 aspect —
  // do not force square.
  emptyStateIcon: {
    width: 96,
    height: 80,
    display: 'block',
    margin: '0 auto 14px',
    objectFit: 'contain',
  },
}
