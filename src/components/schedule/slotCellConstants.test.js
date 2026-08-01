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

describe('assignActivityColors avoids collisions', () => {
  it('gives every activity its own colour while the palette has room', () => {
    const activities = Array.from({ length: 6 }, (_, i) => ({ id: `act-${i}` }))
    const used = [...assignActivityColors(activities).values()]
    expect(new Set(used).size).toBe(6)
  })

  it('does not collide on a small camp, which is where this was first seen', () => {
    // Four activities hashing to three colours is what made the grid look
    // broken on the product owner's own data.
    const activities = Array.from({ length: 4 }, (_, i) => ({ id: `activity-${i}` }))
    const used = [...assignActivityColors(activities).values()]
    expect(new Set(used).size).toBe(4)
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
