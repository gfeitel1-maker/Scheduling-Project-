// Variants of the campB sample (the owner's camp, already committed as
// docs/work/specs/samples/campB-by-day.txt; owner, 2026-10-11: "it is ok to use mine to generate
// synthetic data"). Each is a FILLED, real-shaped week, so the fill-again invariants in
// electron/syntheticCamps.harness.integration.test.js apply to it. Groups and divisions are renamed
// to fictional names in every variant.
//
//   node docs/work/specs/samples/synthetic/campb-variants.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTextGrid } from '../../../../../src/ingest/textGrid.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(HERE, 'campb-variants')
const SOURCE = path.join(HERE, '..', 'campB-by-day.txt')
const DIVISIONS = { Beavers: 'Otters', Badger: 'Herons', Porcupine: 'Foxes', Weasel: 'Lynx', Muskrat: 'Moles', CIT: 'Aides' }

function rename(group) {
  const [word, ...rest] = group.split(' ')
  return [DIVISIONS[word] ?? word, ...rest].join(' ')
}

// The parsed week: days[] of { day, groups[], rows[{ label, cells[] }] }.
function read() {
  const { pages } = parseTextGrid(fs.readFileSync(SOURCE, 'utf8'))
  return pages.map((p) => ({ day: p.title.split(/\s+—/)[0].trim(), groups: p.columns.map(rename), rows: p.rows.map((r) => ({ label: r.label, cells: [...r.cells] })) }))
}

function render(week) {
  return week.map(({ day, groups, rows }) => {
    const widths = groups.map((g, i) => Math.max(g.length, ...rows.map((r) => String(r.cells[i] ?? '').length)) + 3)
    const out = [`${' '.repeat(24)}${day} — All Camp`, '', '   Time'.padEnd(18) + groups.map((g, i) => g.padEnd(widths[i])).join('').trimEnd(), '']
    for (const r of rows) {
      out.push((r.label.replace('-', '–').padEnd(18) + r.cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('')).trimEnd())
      out.push('')
    }
    return out.join('\n')
  }).join('\n\n') + '\n'
}

const pick = (week, idx) => week.map((d) => ({ ...d, groups: idx.map((i) => d.groups[i]), rows: d.rows.map((r) => ({ ...r, cells: idx.map((i) => r.cells[i]) })) }))

// More groups: each extra group copies an existing one's week and takes the next number in its division.
function scaleUp(week, total) {
  const base = week[0].groups
  const next = new Map()
  for (const g of base) { const [w, n] = g.split(' '); next.set(w, Math.max(next.get(w) ?? 0, Number(n) || 1)) }
  const extra = []
  for (let i = 0; base.length + extra.length < total; i = (i + 1) % base.length) {
    const [w] = base[i].split(' ')
    const n = (next.get(w) ?? 1) + 1
    next.set(w, n)
    extra.push({ from: i, name: `${w} ${n}` })
  }
  return week.map((d) => ({ ...d, groups: [...d.groups, ...extra.map((e) => e.name)], rows: d.rows.map((r) => ({ ...r, cells: [...r.cells, ...extra.map((e) => r.cells[e.from])] })) }))
}

function shiftTimes(week, minutes) {
  const shift = (t) => {
    const [h, m] = t.split(':').map(Number)
    let total = h * 60 + m + minutes
    let hh = Math.floor(total / 60) % 24
    if (hh > 12) hh -= 12
    return `${String(hh).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
  }
  return week.map((d) => ({ ...d, rows: d.rows.map((r) => ({ ...r, label: r.label.split(/[-–]/).map((t) => shift(t.trim())).join('-') })) }))
}

// A whole-day item for some groups: every block of that day reads the item's name.
function wholeDay(week, day, groupIdx, name) {
  return week.map((d) => d.day !== day ? d : { ...d, rows: d.rows.map((r) => ({ ...r, cells: r.cells.map((c, i) => (groupIdx.includes(i) ? name : c)) })) })
}

const week = read()
const variants = {
  'b1-renamed': week,
  'b2-8-groups': pick(week, [0, 1, 2, 3, 5, 6, 8, 9]),
  'b3-24-groups': scaleUp(week, 24),
  'b4-times-plus-30': shiftTimes(week, 30),
  'b5-4-day': week.filter((d) => d.day !== 'Friday'),
  'b6-6-day': [...week, { ...week[0], day: 'Saturday' }],
  'b7-trip-and-games-day': wholeDay(wholeDay(week, 'Wednesday', [0, 1, 2], 'Aquarium Trip'), 'Friday', [3, 4, 5, 6, 7], 'Games Day'),
}
fs.mkdirSync(OUT, { recursive: true })
for (const [slug, w] of Object.entries(variants)) fs.writeFileSync(path.join(OUT, `${slug}.txt`), render(w))
console.log(Object.keys(variants).join('\n'))
