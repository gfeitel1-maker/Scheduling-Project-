import { useState } from 'react'
import { prefersReducedMotion } from '../../styles/shared'
import { DOMAIN_LABELS } from './domainRollup.js'
import rootMapArt from '../../assets/reconciliation/root-map.png'

// RootMap — root-map port, docs/adr/2026-08-18-rootmap-screen-port.md §1,
// implementing docs/work/specs/2026-08-18-rootmap-interaction-model.md §1-§6.
// Presentational only, controlled by props — zero business logic.

const STATE_TOKEN = {
  understood: 'var(--secondary)',
  attention: 'var(--accent)',
  changed: 'var(--primary)',
  absent: 'var(--anchor)',
}

const STATE_LABEL = {
  understood: 'Understood',
  attention: 'Needs attention',
  changed: 'Changed',
  absent: 'Not in source',
}

const TILE_STATES = ['understood', 'attention', 'changed', 'absent']

function selectionMatchesNode(selection, domainKey, childKey) {
  if (selection.type !== 'node') return false
  if (childKey) return selection.domainKey === domainKey && selection.childKey === childKey
  return selection.domainKey === domainKey && !selection.childKey
}

function Node({ x, y, width, height, state, label, selected, onSelect }) {
  const [hovered, setHovered] = useState(false)
  const [pressed, setPressed] = useState(false)
  const reduced = prefersReducedMotion()
  const cx = x * width
  const cy = y * height
  const ringOpacity = selected || hovered ? 1 : 0
  const dotRadius = 7
  const showLabel = hovered || selected
  const pressScale = reduced ? 1 : pressed ? 0.9 : 1
  const release = () => setPressed(false)

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
      <circle
        cx={cx}
        cy={cy}
        r={12}
        fill="none"
        stroke={STATE_TOKEN[state]}
        strokeWidth={2.5}
        opacity={ringOpacity}
        style={reduced ? undefined : { transition: 'opacity var(--motion-fast) var(--ease-out)' }}
      />
      <circle
        cx={cx}
        cy={cy}
        r={dotRadius}
        fill={state === 'absent' ? 'none' : STATE_TOKEN[state]}
        stroke={state === 'absent' ? STATE_TOKEN[state] : 'none'}
        strokeWidth={state === 'absent' ? 2 : 0}
        style={reduced ? undefined : { transition: 'fill var(--motion-base) var(--ease-out)' }}
      />
      {showLabel && (
        <g
          style={
            reduced
              ? undefined
              : {
                  opacity: 1,
                  transformOrigin: `${cx}px ${cy}px`,
                  transition: 'opacity var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out)',
                }
          }
        >
          <rect
            x={cx - (label.length * 3.2 + 8)}
            y={cy - 27}
            width={label.length * 6.4 + 16}
            height={18}
            rx={9}
            fill="var(--surface)"
            opacity={0.92}
          />
          <text
            x={cx}
            y={cy - 15}
            textAnchor="middle"
            style={{ fontFamily: 'var(--font-sans)', fontSize: 11, fill: 'var(--text)' }}
          >
            {label}
          </text>
        </g>
      )}
      <foreignObject x={cx - 22} y={cy - 22} width={44} height={44} style={{ overflow: 'visible' }}>
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
          onFocus={() => setHovered(true)}
          onBlur={() => {
            setHovered(false)
            release()
          }}
          onPointerDown={() => setPressed(true)}
          onPointerUp={release}
          style={{
            width: 44,
            height: 44,
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

export default function RootMap({ model, selection, onSelectTile, onSelectNode, onClearSelection }) {
  const width = 1240
  const height = 1240 * 0.62

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
      <div style={styles.tileRow}>
        {TILE_STATES.map((state) => {
          const active = selection.type === 'tile' && selection.state === state
          return (
            <button
              key={state}
              type="button"
              className="press-97"
              aria-pressed={active}
              onClick={() => (active ? onClearSelection() : onSelectTile(state))}
              style={
                active
                  ? {
                      ...styles.tile,
                      ...styles.tileActive,
                      borderColor: STATE_TOKEN[state],
                      background: `color-mix(in srgb, var(--surface) 92%, ${STATE_TOKEN[state]} 8%)`,
                    }
                  : styles.tile
              }
            >
              <div style={{ fontSize: 20, fontWeight: 600, color: 'var(--text)' }}>{tileCounts[state]}</div>
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{STATE_LABEL[state]}</div>
            </button>
          )
        })}
      </div>

      <div style={styles.canvasWrap}>
        <img src={rootMapArt} alt="" style={styles.art} />
        <svg viewBox={`0 0 ${width} ${height}`} style={styles.svg} role="img" aria-label="The root system — what Shoresh took in.">
          {model.domains.map((domain) => (
            <g key={domain.key}>
              {domain.children.map((child) => {
                const isAbsent = child.state === 'absent'
                return (
                  <g
                    key={child.key}
                    opacity={dimmed(domain.key, child.key) ? 0.35 : 1}
                    style={{ transition: 'opacity var(--motion-base) var(--ease-out)' }}
                  >
                    <line
                      x1={domain.x * width}
                      y1={domain.y * height}
                      x2={child.x * width}
                      y2={child.y * height}
                      stroke="var(--anchor)"
                      strokeWidth={1}
                      strokeDasharray={isAbsent ? '2 3' : undefined}
                      opacity={isAbsent ? 0.15 : 0.35}
                    />
                  </g>
                )
              })}
            </g>
          ))}
          {model.domains.map((domain) => (
            <g key={domain.key}>
              <g opacity={dimmed(domain.key, null) ? 0.35 : 1} style={{ transition: 'opacity var(--motion-base) var(--ease-out)' }}>
                <Node
                  x={domain.x}
                  y={domain.y}
                  width={width}
                  height={height}
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
  tileRow: {
    display: 'flex',
    gap: 12,
    marginBottom: 12,
  },
  tile: {
    flex: 1,
    background: 'var(--surface)',
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
