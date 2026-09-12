import { describe, it, expect } from 'vitest'
import { ACTIVITY_COLORS, assignActivityColors, activityColor, setActivityPalette } from './slotCellConstants'

// T18 — the grid's activity colours.
//
// Two separate defects lived here. The first was a collision: colours were
// picked by hashing the activity id, so on the product owner's own camp three
// of four activities landed on the same entry and the grid looked broken
// because it was. The second was that three of the six palette entries were
// indistinguishable to anyone with red-green colour blindness (~6% of men),
// and effectively identical in greyscale — which matters because camps print
// schedules.
//
// These lock the properties, not the hex values. The exact colours are a
// design decision and may be re-picked; what must survive any re-pick is that
// no two are confusable, by anyone, on screen or on paper.

// --- colour-vision simulation (Brettel-style, via LMS) ---
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
const enc = (c) => { c = Math.max(0, Math.min(1, c)); return Math.round(255 * (c <= 0.00304 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)) }
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const luminance = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)

function lms([r, g, b]) {
  const R = lin(r), G = lin(g), B = lin(b)
  return [
    0.31399 * R + 0.63951 * G + 0.04649 * B,
    0.15537 * R + 0.75789 * G + 0.08670 * B,
    0.01776 * R + 0.10945 * G + 0.87262 * B,
  ]
}
function fromLms(L, M, S) {
  return [
    enc(5.47221 * L - 4.6419 * M + 0.16963 * S),
    enc(-1.1252 * L + 2.29317 * M - 0.1678 * S),
    enc(0.02980 * L - 0.19318 * M + 1.16364 * S),
  ]
}
const deuteranopia = (c) => { const [L, M, S] = lms(c); return fromLms(L, 0.494207 * L + 1.24827 * S, S) }
const protanopia = (c) => { const [L, M, S] = lms(c); return fromLms(2.02344 * M - 2.52581 * S, M, S) }
const greyscale = (c) => { const v = enc(luminance(c)); return [v, v, v] }

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

function closestPair(simulate) {
  let worst = Infinity
  let pair = null
  const seen = ACTIVITY_COLORS.map((h) => simulate(hex(h)))
  for (let i = 0; i < seen.length; i++) {
    for (let j = i + 1; j < seen.length; j++) {
      const dist = distance(seen[i], seen[j])
      if (dist < worst) { worst = dist; pair = [ACTIVITY_COLORS[i], ACTIVITY_COLORS[j]] }
    }
  }
  return { worst, pair }
}

// 15 is the floor, not the target. Below roughly this the two read as the same
// colour at the 6px the grid actually draws.
const MIN_SEPARATION = 15

describe('ACTIVITY_COLORS are distinguishable by everyone', () => {
  it('has six distinct entries', () => {
    expect(ACTIVITY_COLORS).toHaveLength(6)
    expect(new Set(ACTIVITY_COLORS).size).toBe(6)
  })

  it('keeps them apart for normal colour vision', () => {
    const { worst, pair } = closestPair((c) => c)
    expect(worst, `closest pair: ${pair?.join(' and ')}`).toBeGreaterThan(MIN_SEPARATION)
  })

  it('keeps them apart under deuteranopia — the case that was broken', () => {
    // The old palette scored 6 here: teal, blue and purple were one colour.
    const { worst, pair } = closestPair(deuteranopia)
    expect(worst, `closest pair: ${pair?.join(' and ')}`).toBeGreaterThan(MIN_SEPARATION)
  })

  it('keeps them apart under protanopia', () => {
    const { worst, pair } = closestPair(protanopia)
    expect(worst, `closest pair: ${pair?.join(' and ')}`).toBeGreaterThan(MIN_SEPARATION)
  })

  it('keeps them apart in greyscale, because camps print schedules', () => {
    // The old palette scored 2 here — a printed dot carried no information at
    // all. This is the constraint most easily lost by re-picking on screen.
    const { worst, pair } = closestPair(greyscale)
    expect(worst, `closest pair: ${pair?.join(' and ')}`).toBeGreaterThan(MIN_SEPARATION)
  })
})

// T52 — colour now means HOW OFTEN AN ACTIVITY RUNS (owner decision,
// 2026-09-12). The palette is a dark-to-light ramp, and a ramp is an ORDER:
// dark = runs most often. Two activities that run equally often therefore
// SHARE a colour, deliberately. That replaces the old model, where a colour
// was a per-activity identity badge and collisions were the bug — the two
// tests asserting one-colour-per-activity were removed with this change, not
// broken by it.
describe('assignActivityColors encodes frequency', () => {
  it('gives the same colour to activities that run equally often', () => {
    const used = [...assignActivityColors([
      { id: 'swim', min_per_week: 3 },
      { id: 'arts', min_per_week: 3 },
    ]).values()]
    expect(used[0]).toBe(used[1])
  })

  it('runs more often => darker rung', () => {
    const m = assignActivityColors([
      { id: 'daily', min_per_week: 5 },
      { id: 'weekly', min_per_week: 1 },
    ])
    expect(ACTIVITY_COLORS.indexOf(m.get('daily')))
      .toBeLessThan(ACTIVITY_COLORS.indexOf(m.get('weekly')))
  })

  it('is a FIXED scale, not a ranking — adding an activity never recolours the others', () => {
    const before = assignActivityColors([{ id: 'swim', min_per_week: 2 }])
    const after = assignActivityColors([
      { id: 'swim', min_per_week: 2 },
      { id: 'newthing', min_per_week: 5 },
    ])
    expect(after.get('swim')).toBe(before.get('swim'))
  })

  it('treats anything at or above the top of the scale as the darkest rung', () => {
    const m = assignActivityColors([
      { id: 'five', min_per_week: 5 },
      { id: 'seven', min_per_week: 7 },
    ])
    expect(m.get('five')).toBe(ACTIVITY_COLORS[0])
    expect(m.get('seven')).toBe(ACTIVITY_COLORS[0])
  })

  it('puts an unset frequency at the palest rung — least often, or nobody has said', () => {
    const m = assignActivityColors([{ id: 'unknown' }, { id: 'null', min_per_week: null }])
    expect(m.get('unknown')).toBe(ACTIVITY_COLORS[5])
    expect(m.get('null')).toBe(ACTIVITY_COLORS[5])
  })

  it('is stable — the same activities always get the same colours', () => {
    const activities = [{ id: 'b' }, { id: 'a' }, { id: 'c' }]
    expect([...assignActivityColors(activities)]).toEqual([...assignActivityColors([...activities].reverse())])
  })

  it('still gives a colour once there are more activities than entries', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `act-${i}` }))
    setActivityPalette(many)
    for (const a of many) expect(ACTIVITY_COLORS).toContain(activityColor(a.id))
  })
})

// T52 constraint (B) — colour renders as a 6px `.identity-dot` on the cell
// surface (scheduleGrid.css:217), never as a cell fill. A rung that looks fine
// as a large swatch can be invisible at 6px: the first ramp proposed for this
// change had a palest rung at 1.35:1, which is not a dot, it is nothing.
//
// This is the constraint that actually binds when someone lightens the ramp to
// make the grid prettier, and the separation checks above will not catch it.
const SURFACE = '#FCFBF8'
const relLum = (h) => { const [r, g, b] = hex(h); return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b) }
const contrast = (a, b) => {
  const x = relLum(a), y = relLum(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

describe('ACTIVITY_COLORS survive being a 6px dot', () => {
  it('every rung clears 3:1 against the cell surface', () => {
    for (const c of ACTIVITY_COLORS) {
      expect(contrast(c, SURFACE), `${c} against ${SURFACE}`).toBeGreaterThanOrEqual(3)
    }
  })

  it('the palest rung is still clearly a mark, not a smudge', () => {
    const palest = ACTIVITY_COLORS.reduce((a, b) => (relLum(a) > relLum(b) ? a : b))
    expect(contrast(palest, SURFACE), `palest rung ${palest}`).toBeGreaterThanOrEqual(3)
  })
})
