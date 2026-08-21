import { useState, useEffect } from 'react'
import { prefersReducedMotion } from '../../styles/shared'
import { DOMAIN_LABELS } from './domainRollup.js'
import { NODE_LAYOUT } from './rootMapLayout.js'
import rootMapArt from '../../assets/reconciliation/root-map-3d.webp'
import orbUnderstood from '../../assets/reconciliation/orb_understood.png'
import orbAttention from '../../assets/reconciliation/orb_attention.png'
import orbChanged from '../../assets/reconciliation/orb_changed.png'
import orbAbsent from '../../assets/reconciliation/orb_absent.png'
import orbNotSetUp from '../../assets/reconciliation/orb_not_set_up.png'

// Woodcut-orb "lantern" sprite per state (engraved sepia orbs on the 3D-relief
// roots). Baked from scratchpad/blender-roots/production_bake.py — one sprite
// per state so a state change is an <image> href swap, no runtime tinting.
const STATE_SPRITE = {
  understood: orbUnderstood,
  attention: orbAttention,
  changed: orbChanged,
  absent: orbAbsent,
  not_set_up: orbNotSetUp,
}

// RootMap — root-map port, docs/adr/2026-08-18-rootmap-screen-port.md §1,
// implementing docs/work/specs/2026-08-18-rootmap-interaction-model.md §1-§6.
// Presentational only, controlled by props — zero business logic.

const STATE_TOKEN = {
  understood: 'var(--secondary)',
  attention: 'var(--accent)',
  changed: 'var(--primary)',
  absent: 'var(--anchor)',
  // Required-5 only (docs/adr/2026-08-19-roots-census-and-persistent-
  // inspector.md §(d), R3) — "this domain applies and nobody has touched it
  // yet", a distinct claim from 'absent' ("positive evidence this domain
  // doesn't apply"). --border is otherwise unused as a node token, muted and
  // distinct from the other four semantic colors.
  not_set_up: 'var(--border)',
}

const STATE_LABEL = {
  understood: 'Understood',
  attention: 'Needs attention',
  changed: 'Changed',
  absent: 'Not in source',
  not_set_up: 'Not set up yet',
}

const TILE_STATES = ['understood', 'attention', 'changed', 'absent']

function selectionMatchesNode(selection, domainKey, childKey) {
  if (selection.type !== 'node') return false
  if (childKey) return selection.domainKey === domainKey && selection.childKey === childKey
  return selection.domainKey === domainKey && !selection.childKey
}

// Hover-driven glow is a mouse affordance; a touch tap fires the same
// mouseenter without a matching leave, so it would otherwise leave a lit
// node stuck. Computed once (not per-render) — matchMedia is undefined in
// SSR/jsdom without a mock, so default to true (fine pointer) there.
function hasFinePointer() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches
}

function Node({ x, y, width, height, state, label, selected, onSelect, radius }) {
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [pressed, setPressed] = useState(false)
  const [finePointer] = useState(hasFinePointer)
  const reduced = prefersReducedMotion()
  const cx = x * width
  const cy = y * height
  const r = radius
  const pressScale = reduced ? 1 : pressed ? 0.96 : 1
  const release = () => setPressed(false)

  // Label pill shows on hover only after a short delay, so a quick pointer
  // sweep across nodes doesn't flash a string of labels. Focus shows the
  // label immediately (keyboard navigation has no "sweep"). The reset-on-
  // unhover follows the same render-time-adjustment pattern as labelEntered
  // below, rather than a synchronous setState in the effect body.
  const [labelShown, setLabelShown] = useState(false)
  const [prevHovered, setPrevHovered] = useState(hovered)
  if (hovered !== prevHovered) {
    setPrevHovered(hovered)
    if (!hovered) setLabelShown(false)
  }
  useEffect(() => {
    if (!hovered || labelShown) return
    const id = setTimeout(() => setLabelShown(true), 120)
    return () => clearTimeout(id)
  }, [hovered, labelShown])

  // Keyboard focus always lights the node; mouse hover only does on a fine
  // pointer, so a touch tap can't leave a stuck glow.
  const active = selected || focused || (hovered && finePointer)
  const showLabel = focused || (hovered && labelShown) || selected

  // The label pill reads as "arriving" (scale-in with the fade), not popping in
  // at full size. Reset-on-deactivate happens during render (React's documented
  // "adjust state when a prop changes" pattern), so the effect only ever sets
  // the entered flag true — guarded so it never fires redundantly.
  const [labelEntered, setLabelEntered] = useState(false)
  const [prevShowLabel, setPrevShowLabel] = useState(showLabel)
  if (showLabel !== prevShowLabel) {
    setPrevShowLabel(showLabel)
    if (!showLabel) setLabelEntered(false)
  }
  useEffect(() => {
    if (!showLabel || labelEntered) return
    const id = requestAnimationFrame(() => setLabelEntered(true))
    return () => cancelAnimationFrame(id)
  }, [showLabel, labelEntered])

  // Glow: the lantern lights on hover/selection (strong, in the state colour);
  // the needs-attention orb pulses on its own (CSS keyframe in index.css) unless
  // it is already hovered/selected. Understood/changed stay calm at rest — the
  // glow is a *runtime* cue, never a static tint on the whole screen.
  //
  // The glow shape (blur, gradient edge) is painted ONCE via the static
  // #rootmap-glow-blur filter; only its opacity ever changes, so nothing here
  // triggers a repaint of the blur itself (RA-1 — animating `filter` is
  // expensive per-frame, `opacity` is compositor-only).
  const glowColor = STATE_TOKEN[state]
  // A static glow is not motion, so the hover/selection glow applies even
  // under reduced-motion (a selected lantern must still read as selected); only
  // the transition and the attention pulse are gated as animation.
  const glowStyle = {
    opacity: active ? 0.9 : 0,
    transition: reduced ? undefined : 'opacity var(--motion-base) var(--ease-out)',
  }
  const pulse = state === 'attention' && !active && !reduced ? 'rootmap-orb--pulse' : ''

  return (
    <g
      style={
        reduced
          ? undefined
          : {
              transform: `scale(${pressScale})`,
              transformOrigin: `${cx}px ${cy}px`,
              transition: 'transform var(--motion-fast) var(--ease-out)',
            }
      }
    >
      {/* hook: the lantern hangs from its root */}
      <line
        x1={cx}
        y1={cy - r + 2}
        x2={cx - 2}
        y2={cy - r - 11}
        stroke="#6b573c"
        strokeWidth={1.5}
        opacity={0.45}
      />
      {/* RA-6: a quiet always-on ring so every orb reads as interactive at
          rest, independent of hover/selection state (which lights the glow
          above). No fill, no animation — it must never compete with the
          hover/selection glow that sits above it in paint order. */}
      <circle cx={cx} cy={cy} r={r + 4} fill="none" stroke="var(--anchor)" strokeWidth={1} opacity={0.28} />
      <circle
        cx={cx}
        cy={cy}
        r={r * 0.82}
        fill={glowColor}
        filter="url(#rootmap-glow-blur)"
        className={pulse}
        style={glowStyle}
      />
      <image
        href={STATE_SPRITE[state]}
        x={cx - r}
        y={cy - r}
        width={r * 2}
        height={r * 2}
      />
      {showLabel && (
        <g
          style={
            reduced
              ? {
                  opacity: labelEntered ? 1 : 0,
                  transition: 'opacity var(--motion-fast) var(--ease-out)',
                }
              : {
                  opacity: labelEntered ? 1 : 0,
                  transform: labelEntered ? 'scale(1)' : 'scale(0.95)',
                  transformOrigin: `${cx}px ${cy}px`,
                  transition: 'opacity var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out)',
                }
          }
        >
          <rect
            x={cx - (label.length * 3.2 + 8)}
            y={cy - r - 26}
            width={label.length * 6.4 + 16}
            height={18}
            rx={9}
            fill="var(--surface)"
            opacity={0.92}
          />
          <text
            x={cx}
            y={cy - r - 14}
            textAnchor="middle"
            style={{ fontFamily: 'var(--font-sans)', fontSize: 11, fill: 'var(--text)' }}
          >
            {label}
          </text>
        </g>
      )}
      <foreignObject x={cx - r - 4} y={cy - r - 4} width={r * 2 + 8} height={r * 2 + 8} style={{ overflow: 'visible' }}>
        <button
          type="button"
          aria-label={`${label} — ${STATE_LABEL[state]}`}
          aria-pressed={selected}
          onClick={onSelect}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => {
            setHovered(false)
            release()
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            release()
          }}
          onPointerDown={() => setPressed(true)}
          onPointerUp={release}
          onPointerCancel={() => {
            setHovered(false)
            release()
          }}
          style={{
            width: '100%',
            height: '100%',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
          }}
        />
      </foreignObject>
    </g>
  )
}

const DOMAIN_RADIUS = 24
const CHILD_RADIUS = 17

// Matches the width/height RootMap renders its <svg> viewBox at, below —
// module-level so the crown-ceiling math (also module-level) can use the
// same scale without eyeballing a second copy of the numbers.
const WIDTH = 1240
const HEIGHT = WIDTH * 0.62

// RA-9 review round 2 (HIGH) — the ADR's premise that CROWN.y = 0.30 sits
// "above the domain node band, domains start at y≈0.33" was arithmetically
// wrong: the topmost real node (Scheduling, y=0.3299, radius 24) has its top
// edge at y≈0.299 of the viewBox, so a hand-picked 0.30 anchor plus the
// tags' own downward offsets (+0.070) plunged tags into the node band and
// stole their clicks. Computed from the real positions in rootMapLayout.js
// instead of a second hand-picked constant, so it can never drift out of
// sync with the layout again: the minimum top-edge y across every domain
// AND child node, minus a safety margin.
const CROWN_SAFETY_MARGIN_PX = 16

function computeNodeBandCeilingNormalized() {
  let minTopNormalized = Infinity
  for (const domain of Object.values(NODE_LAYOUT)) {
    minTopNormalized = Math.min(minTopNormalized, domain.y - DOMAIN_RADIUS / HEIGHT)
    for (const child of Object.values(domain.children ?? {})) {
      minTopNormalized = Math.min(minTopNormalized, child.y - CHILD_RADIUS / HEIGHT)
    }
  }
  return minTopNormalized - CROWN_SAFETY_MARGIN_PX / HEIGHT
}

const NODE_BAND_CEILING_Y = computeNodeBandCeilingNormalized()

// RA-9 (docs/adr/2026-08-21-roots-tree-as-primary.md) — the 4 tile counts
// hang from one fixed crown anchor, trunk-pixel-independent. Normalized
// [0,1] coordinates, same convention as rootMapLayout.js. Same fan shape and
// left/right ordering the ADR specified (attention/changed innermost and
// lowest) — only CROWN.y moves, derived below so every tag clears
// NODE_BAND_CEILING_Y.
const CROWN_TAG_OFFSETS = {
  understood: { dx: -0.115, dy: 0.045 },
  attention: { dx: -0.045, dy: 0.070 },
  changed: { dx: 0.045, dy: 0.070 },
  absent: { dx: 0.115, dy: 0.045 },
}
// Presentational sizing (not ADR-specified) — sized to fit the 20px/12px
// count/label text the tags reuse from today's tile styling.
const CROWN_TAG_WIDTH = 132
const CROWN_TAG_HEIGHT = 44

const CROWN_MAX_TAG_DY = Math.max(...Object.values(CROWN_TAG_OFFSETS).map((o) => o.dy))
const CROWN = {
  x: 0.5,
  y: NODE_BAND_CEILING_Y - CROWN_MAX_TAG_DY - (CROWN_TAG_HEIGHT / 2) / HEIGHT,
}

function CrownCluster({ width, height, tileCounts, selection, onSelectTile, onClearSelection }) {
  const crownX = CROWN.x * width
  const crownY = CROWN.y * height
  return (
    <g data-crown-cluster="true">
      {TILE_STATES.map((state) => {
        const offset = CROWN_TAG_OFFSETS[state]
        const cx = crownX + offset.dx * width
        const cy = crownY + offset.dy * height
        const tagX = cx - CROWN_TAG_WIDTH / 2
        const tagY = cy - CROWN_TAG_HEIGHT / 2
        const active = selection.type === 'tile' && selection.state === state
        return (
          <g key={state}>
            {/* hook-thread: reuses Node's lantern-hook treatment so the four
                independent tags read as hanging from one point. */}
            <line x1={cx} y1={tagY} x2={crownX} y2={crownY} stroke="#6b573c" strokeWidth={1.5} opacity={0.45} />
            <foreignObject x={tagX} y={tagY} width={CROWN_TAG_WIDTH} height={CROWN_TAG_HEIGHT} style={{ overflow: 'visible' }}>
              <button
                type="button"
                className="press-97"
                aria-pressed={active}
                onClick={() => (active ? onClearSelection() : onSelectTile(state))}
                style={
                  active
                    ? {
                        ...styles.tile,
                        ...styles.tileActive,
                        borderLeftWidth: 3,
                        borderColor: STATE_TOKEN[state],
                        background: `color-mix(in srgb, var(--surface) 92%, ${STATE_TOKEN[state]} 8%)`,
                      }
                    : { ...styles.tile, borderLeftWidth: 3, borderLeftColor: STATE_TOKEN[state] }
                }
              >
                <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--text)' }}>{tileCounts[state]}</div>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{STATE_LABEL[state]}</div>
              </button>
            </foreignObject>
          </g>
        )
      })}
    </g>
  )
}

export default function RootMap({ model, selection, onSelectTile, onSelectNode, onClearSelection, canvasWrapRef }) {
  const width = WIDTH
  const height = HEIGHT

  const dimmed = (domainKey, childKey) => {
    if (selection.type !== 'tile') return false
    const domain = model.domains.find((d) => d.key === domainKey)
    if (childKey) {
      const child = domain?.children.find((c) => c.key === childKey)
      return child ? child.state !== selection.state : true
    }
    return domain ? domain.state !== selection.state : true
  }

  const tileCounts = TILE_STATES.reduce((acc, state) => {
    acc[state] = model.domains.reduce(
      (sum, d) => sum + d.children.filter((c) => c.state === state).length,
      0,
    )
    return acc
  }, {})

  return (
    <div>
      {/* RA-8: static self-describing legend, canvas domain order left→right,
          sourced live from DOMAIN_LABELS so it can never drift from the
          canvas's own labels. Quiet by design — no motion, no interaction. */}
      <div style={styles.legend}>
        {Object.values(DOMAIN_LABELS).join(' · ')}
      </div>

      <div style={styles.canvasWrap} ref={canvasWrapRef}>
        <img src={rootMapArt} alt="" style={styles.art} />
        <svg viewBox={`0 0 ${width} ${height}`} style={styles.svg} role="img" aria-label="The root system — what Shoresh took in.">
          <defs>
            {/* Static blur, painted once — RA-1: node glow only ever
                animates opacity on the shapes that reference this filter,
                never the filter itself. */}
            <filter id="rootmap-glow-blur" x="-100%" y="-100%" width="300%" height="300%">
              <feGaussianBlur stdDeviation="6" />
            </filter>
          </defs>
          {/* Crown cluster renders FIRST — round-2 review fix: with zero
              overlap against the node band (see NODE_BAND_CEILING_Y above)
              paint order no longer matters for click-stealing, but painting
              it first also fixes DOM/tab order so the 4 filter buttons come
              before the node buttons, matching visual reading order
              (crown, then roots). */}
          <CrownCluster
            width={width}
            height={height}
            tileCounts={tileCounts}
            selection={selection}
            onSelectTile={onSelectTile}
            onClearSelection={onClearSelection}
          />
          {/* No straight connector lines: the drawn roots of the 3D backdrop
              already carry each child down from its domain, so an overlaid line
              would read as a competing (and geometrically wrong) extra root. */}
          {model.domains.map((domain) => (
            <g key={domain.key}>
              <g opacity={dimmed(domain.key, null) ? 0.35 : 1} style={{ transition: 'opacity var(--motion-base) var(--ease-out)' }}>
                <Node
                  x={domain.x}
                  y={domain.y}
                  width={width}
                  height={height}
                  radius={DOMAIN_RADIUS}
                  state={domain.state}
                  label={DOMAIN_LABELS[domain.key] ?? domain.label}
                  selected={selectionMatchesNode(selection, domain.key, null)}
                  onSelect={() => onSelectNode(domain.key, null)}
                />
              </g>
              {domain.children.map((child) => (
                <g key={child.key} opacity={dimmed(domain.key, child.key) ? 0.35 : 1} style={{ transition: 'opacity var(--motion-base) var(--ease-out)' }}>
                  <Node
                    x={child.x}
                    y={child.y}
                    width={width}
                    height={height}
                    radius={CHILD_RADIUS}
                    state={child.state}
                    label={child.count ? `${child.name} — ${child.count}` : child.name}
                    selected={selectionMatchesNode(selection, domain.key, child.key)}
                    onSelect={() => onSelectNode(domain.key, child.key)}
                  />
                </g>
              ))}
            </g>
          ))}
        </svg>
      </div>
    </div>
  )
}

const styles = {
  tile: {
    width: '100%',
    height: '100%',
    background: 'var(--surface)',
    opacity: 0.94,
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: '10px 14px',
    textAlign: 'left',
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  tileActive: {
    borderWidth: 2,
  },
  legend: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-sans)',
    marginBottom: 8,
  },
  canvasWrap: {
    position: 'relative',
    width: '100%',
    borderRadius: 8,
    overflow: 'hidden',
  },
  art: {
    display: 'block',
    width: '100%',
    height: 'auto',
  },
  svg: {
    position: 'absolute',
    inset: 0,
    width: '100%',
    height: '100%',
  },
}
