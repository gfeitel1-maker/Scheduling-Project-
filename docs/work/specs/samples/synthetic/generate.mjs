// Regenerates the 15 synthetic schedule files, manifest.json and README.md in this directory.
//   node docs/work/specs/samples/synthetic/generate.mjs
// Every name is fictional. The generator is the source of truth for each camp's expected facts
// (groups, lunch waves, events), so the manifest the harness reads can never disagree with the grid.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ALL_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const SUN_THU = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday']

const POOL = [
  'Archery', 'Arts and Crafts', 'Basketball', 'Ceramics', 'Chess Club', 'Climbing Wall', 'Dance', 'Drama',
  'Drumming', 'Fishing', 'Gaga Pit', 'Garden', 'Hiking', 'Kayaking', 'Knitting', 'Lanyard', 'Music',
  'Nature Walk', 'Orienteering', 'Painting', 'Pottery', 'Robotics', 'Sailing', 'Soccer', 'Softball',
  'Storytelling', 'Swim', 'Tennis', 'Tie Dye', 'Trampoline', 'Volleyball', 'Woodworking', 'Yoga',
  'Free Swim', 'Rocketry', 'Photography', 'Cooking', 'Magic Show', 'Puppetry', 'Bocce',
]
const COLLIDERS = ['Lunch Bunch', 'Swim Test']
const TYPOS = { Music: 'Musik', Archery: 'Archary' }
const ROOMS = ['Barn', 'Lake', 'Loft', 'Meadow', 'Field 1', 'Field 2', 'Studio B', 'Pavilion', 'Shed', 'Dock']
const DIVISION_WORDS = ['Otters', 'Herons', 'Foxes', 'Lynx', 'Moles', 'Voles', 'Swifts', 'Wrens']
const UNIT_WORDS = ['Sparks', 'Embers', 'Flints', 'Tinders', 'Kindlers']

const pad2 = (n) => String(n).padStart(2, '0')
function clockText(min, clock) {
  const h = Math.floor(min / 60)
  const m = min % 60
  if (clock === '24') return `${pad2(h)}:${pad2(m)}`
  const h12 = ((h + 11) % 12) + 1
  return clock === 'ampm' ? `${pad2(h12)}:${pad2(m)} ${h < 12 ? 'AM' : 'PM'}` : `${pad2(h12)}:${pad2(m)}`
}

function wrap(text, width) {
  if (text.length <= width || !text.includes(' ')) return [text]
  const words = text.split(' ')
  let best = 1
  let bestGap = Infinity
  for (let i = 1; i < words.length; i++) {
    const gap = Math.abs(words.slice(0, i).join(' ').length - words.slice(i).join(' ').length)
    if (gap < bestGap) { bestGap = gap; best = i }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')]
}

function splitInto(items, n) {
  const out = []
  const base = Math.floor(items.length / n)
  let extra = items.length % n
  let at = 0
  for (let i = 0; i < n; i++) {
    const size = base + (extra-- > 0 ? 1 : 0)
    out.push(items.slice(at, at + size))
    at += size
  }
  return out
}

// Builds [{ s, e, kind }] from a plan of [kind, duration, gapAfter] starting at `start` minutes.
function layoutBlocks(start, plan) {
  let t = start
  return plan.map(([kind, dur, gap = 5]) => {
    const b = { kind, s: t, e: t + dur }
    t += dur + gap
    return b
  })
}

function makeGroups(spec) {
  if (spec.groupNames) return spec.groupNames
  const names = []
  for (let d = 0; d < spec.divisions; d++) {
    const count = Math.floor(spec.groupCount / spec.divisions) + (d < spec.groupCount % spec.divisions ? 1 : 0)
    for (let i = 1; i <= count; i++) {
      names.push({ unit: UNIT_WORDS[d % 5] + (d >= 5 ? ` ${d}` : ''), word: DIVISION_WORDS[d % 8] + (d >= 8 ? ` ${d}` : ''), n: i })
    }
  }
  return names
}

function build(spec) {
  const days = spec.days ?? ALL_DAYS.slice(0, spec.dayCount)
  const groupSeeds = makeGroups(spec)
  let groups
  let divisions
  if (spec.layout === 'byGroup') {
    groups = groupSeeds.map((g) => ({ unit: g.unit, name: `${g.word} ${g.n}`, title: `${g.unit} - ${g.word} ${g.n}` }))
    divisions = [...new Set(groups.map((g) => g.unit))]
  } else if (spec.layout === 'daySheet') {
    groups = groupSeeds.map((g, i) => {
      const prefix = String(Math.floor(i / 4) + 1)
      const code = `${prefix}${'ABCD'[i % 4]}`
      return { unit: prefix, name: code, title: code }
    })
    divisions = [...new Set(groups.map((g) => g.unit))]
  } else {
    groups = groupSeeds.map((g) => ({ unit: g.word, name: `${g.word} ${g.n}`, title: `${g.word} ${g.n}` }))
    divisions = [...new Set(groups.map((g) => g.unit))]
  }
  if (spec.extraGroup) {
    groups.push({ unit: spec.extraGroup, name: spec.extraGroup, title: spec.extraGroup })
    divisions.push(spec.extraGroup)
  }
  const names = groups.map((g) => g.name)

  const blocks = layoutBlocks(spec.start, spec.plan)
  const lunchRows = blocks.map((b, i) => (b.kind === 'LUNCH' ? i : -1)).filter((i) => i >= 0)
  const mealGroups = spec.extraGroup && spec.cutLunch ? names.filter((n) => n !== spec.extraGroup) : names
  const waveGroups = lunchRows.length ? splitInto(mealGroups, lunchRows.length) : []
  const waveName = (w) => (lunchRows.length === 1 ? 'Lunch' : `Lunch ${w + 1}`)

  let pool = POOL.slice(spec.poolOffset ?? 0).concat(POOL.slice(0, spec.poolOffset ?? 0))
  pool = [...(spec.colliders ?? []), ...pool].slice(0, spec.activityCount)
  while (pool.length < spec.activityCount) pool.push(`Elective ${pool.length}`)

  const pick = (sel) => {
    if (sel === 'all') return [...names]
    if (Array.isArray(sel)) return sel
    if (sel.except) return names.filter((n) => !sel.except.includes(n))
    if (sel.idx) return sel.idx.map((i) => names[i])
    return groups.filter((g) => sel.divs.some((d) => divisions[d] === g.unit)).map((g) => g.name)
  }
  const allRows = blocks.map((_, i) => i)
  const events = []
  for (const w of waveGroups.keys()) {
    events.push({ name: waveName(w), kind: 'lunch', days: [...days], groups: waveGroups[w], rows: [lunchRows[w]] })
  }
  blocks.forEach((b, i) => {
    if (b.kind !== 'free' && b.kind !== 'LUNCH') {
      events.push({ name: b.kind, kind: 'daily', days: [...days], groups: [...names], rows: [i] })
    }
  })
  for (const e of spec.events ?? []) {
    const dayIdx = e.days === 'all' ? days.map((_, i) => i) : e.days
    events.push({ name: e.name, kind: e.kind, days: dayIdx.map((i) => days[i]), groups: pick(e.groups), rows: [e.row], ...(e.groups.except ? { allExcept: e.groups.except } : {}) })
  }
  // Trips (some groups, part of a day) and all-day special days displace whatever else is printed, so they go first.
  const displacing = []
  for (const t of spec.trips ?? []) displacing.push({ name: t.name, kind: 'trip', days: [days[t.day]], groups: pick(t.groups), rows: t.rows })
  for (const a of spec.allDay ?? []) displacing.push({ name: a.name, kind: 'allday', days: [days[a.day]], groups: pick(a.groups), rows: allRows, ...(a.groups.except ? { allExcept: a.groups.except } : {}) })
  events.unshift(...displacing)

  const eventAt = (gi, di, ri) => events.find((e) => e.rows.includes(ri) && e.days.includes(days[di]) && e.groups.includes(names[gi]))
  const overrides = new Map()
  const setOverride = (gi, di, ri, cell) => {
    const k = `${gi}|${di}|${ri}`
    if (eventAt(gi, di, ri) || overrides.has(k) || blocks[ri].kind !== 'free') throw new Error(`${spec.slug}: ${cell.role} collides at group ${names[gi]} ${days[di]} row ${ri}`)
    overrides.set(k, cell)
  }
  const spans = (spec.spans ?? []).map((sp) => ({ ...sp, groups: pick(sp.groups), days: sp.days.map((d) => days[d]) }))
  for (const sp of spans) {
    for (const g of sp.groups) for (const d of sp.days) for (let k = 0; k < sp.n; k++) {
      setOverride(names.indexOf(g), days.indexOf(d), sp.row + k, { text: k === 0 || sp.form === 'repeat' ? sp.name : '', role: 'span' })
    }
  }
  const electives = (spec.electives ?? []).map((el) => ({ ...el, groups: pick(el.groups), days: el.days.map((d) => days[d]) }))
  for (const el of electives) {
    for (const g of el.groups) for (const d of el.days) for (const r of el.rows) {
      setOverride(names.indexOf(g), days.indexOf(d), r, { text: el.form === 'list' ? el.offerings.join(' / ') : el.name, role: 'elective' })
    }
  }

  const typoLeft = { ...(spec.typos ?? {}) }
  const grid = []
  let c = 0
  const counts = { blank: 0, split: 0, typo: 0, wrapped: 0 }
  const used = new Map()
  for (let gi = 0; gi < names.length; gi++) {
    grid.push([])
    for (let di = 0; di < days.length; di++) {
      grid[gi].push([])
      for (let ri = 0; ri < blocks.length; ri++) {
        const ev = eventAt(gi, di, ri)
        if (ev) { grid[gi][di].push({ text: ev.name, event: true }); continue }
        const ov = overrides.get(`${gi}|${di}|${ri}`)
        if (ov) { grid[gi][di].push({ text: ov.text, event: false, role: ov.role }); continue }
        let text = pool[c % pool.length]
        const base = text
        c++
        used.set(base, (used.get(base) ?? 0) + 1)
        if (spec.blankEvery && c % spec.blankEvery === 0) { text = ''; counts.blank++ } else if (spec.splitEvery && c % spec.splitEvery === 0) {
          text = `${text} - ${pool[(c + 1) % pool.length]}`; counts.split++
        } else if (typoLeft[base] > 0 && used.get(base) % 3 === 0) {
          text = TYPOS[base]; typoLeft[base]--; counts.typo++
        }
        grid[gi][di].push({ text, event: false })
      }
    }
  }
  const starved = pool.filter((p) => (used.get(p) ?? 0) < 3)
  if (starved.length) throw new Error(`${spec.slug}: activities used fewer than 3 times: ${starved.join(', ')}`)

  return { spec, days, groups, names, divisions, blocks, events, pool, grid, counts, lunchRows, waveGroups, waveName, spans, electives }
}

const label = (b, clock) => `${clockText(b.s, clock)}–${clockText(b.e, clock)}`

function renderTable(camp, colHeads, cellOf, title, header) {
  const { spec, blocks } = camp
  const timeW = 18
  const wrapAt = spec.wrapAt ?? 100
  const widths = colHeads.map((h, ci) => {
    let w = h.length
    for (let ri = 0; ri < blocks.length; ri++) {
      for (const line of wrap(cellOf(ci, ri), wrapAt)) w = Math.max(w, line.length)
    }
    return w + 3
  })
  const out = [title, '', `   ${header}`.padEnd(timeW) + colHeads.map((h, i) => h.padEnd(widths[i])).join('').trimEnd(), '']
  for (let ri = 0; ri < blocks.length; ri++) {
    const cells = colHeads.map((_, ci) => wrap(cellOf(ci, ri), wrapAt))
    const n = Math.max(...cells.map((x) => x.length))
    if (n > 1) camp.counts.wrapped++
    for (let k = 0; k < n; k++) {
      out.push(((k === 0 ? label(blocks[ri], spec.clock) : '').padEnd(timeW) + cells.map((x, i) => (x[k] ?? '').padEnd(widths[i])).join('')).trimEnd())
    }
    out.push('')
  }
  return out.join('\n')
}

function renderByDay(camp) {
  const { spec, days, names, grid } = camp
  const pages = days.map((day, di) => {
    const title = spec.layout === 'byDayPeriod' ? `${' '.repeat(24)}${day.toUpperCase()} SCHEDULE` : `${' '.repeat(24)}${day} — All Camp`
    return renderTable(camp, names, (ci, ri) => grid[ci][di][ri].text, title, spec.layout === 'byDayPeriod' ? 'Period' : 'Time')
  })
  return pages.join('\n\n') + '\n'
}

function renderByGroup(camp) {
  const { days, groups, grid } = camp
  const pages = groups.map((g, gi) => renderTable(camp, days, (di, ri) => grid[gi][di][ri].text, `${' '.repeat(14)}${g.title} Schedule`, 'Time'))
  return pages.join('\n\n') + '\n'
}

function renderDaySheet(camp) {
  const { spec, days, groups, grid, blocks } = camp
  const colX = (i) => 18 + i * 30
  const placeAt = (arr, x) => {
    let line = ''
    arr.forEach((t, i) => { line = line.padEnd(x(i)) + t })
    return line
  }
  const place = (arr) => placeAt(arr, (i) => colX(i) - 3)
  const pages = groups.map((g, gi) => {
    const out = [`${' '.repeat(55)}Sample Camp 2101`, `${' '.repeat(63)}${g.title}`]
    out.push(placeAt(days, colX))
    blocks.forEach((b, ri) => {
      out.push(clockText(b.s, spec.clock))
      const row = days.map((_, di) => grid[gi][di][ri])
      out.push(place(row.map((x) => x.text)))
      if (row.some((x) => x.text && !x.event)) out.push(place(row.map((x) => (x.text && !x.event ? ROOMS[(x.text.length + gi) % ROOMS.length] : ''))))
      out.push(clockText(b.e, spec.clock), '')
    })
    return out.join('\n')
  })
  return pages.join('\n\n') + '\n'
}

const SPECS = [
  { slug: 's01-by-day-small-5d', layout: 'byDay', dayCount: 5, groupCount: 6, divisions: 2, clock: '12', start: 540, activityCount: 12, colliders: ['Lunch Bunch'],
    plan: [['Arrival', 15], ['free', 45], ['free', 45], ['LUNCH', 40], ['free', 45], ['free', 45], ['Dismissal', 15, 0]],
    events: [{ name: 'Assembly', kind: 'weekly', days: [0], row: 1, groups: 'all' }],
    traits: 'Baseline: clean 5-day by-day grid, 6 groups, 2 divisions, one lunch wave for everyone, 12h times, "Lunch Bunch" activity beside the Lunch event.' },
  { slug: 's02-by-day-three-waves', layout: 'byDay', dayCount: 5, groupCount: 14, divisions: 4, clock: '12', start: 525, activityCount: 25, poolOffset: 3, typos: { Music: 3 }, wrapAt: 14,
    plan: [['Carpool', 20], ['Morning Circle', 15], ['free', 40], ['free', 40], ['LUNCH', 40], ['LUNCH', 40], ['LUNCH', 40], ['free', 40], ['free', 35], ['Pick Up', 20, 0]],
    events: [{ name: 'Library', kind: 'alternate', days: [0, 2, 4], row: 2, groups: 'all' }],
    traits: 'campB-style: three staggered lunch waves (Lunch 1/2/3) across consecutive blocks, 14 groups in 4 divisions, uneven 35/40-minute blocks, "Musik" typo, wrapped long names, every-other-day Library.' },
  { slug: 's03-by-day-4day-24h-nolunch', layout: 'byDay', dayCount: 4, groupCount: 3, divisions: 1, clock: '24', start: 600, activityCount: 8, colliders: ['Swim Test'], blankEvery: 7,
    plan: [['Welcome Circle', 15, 0], ['free', 30, 0], ['free', 30, 0], ['free', 30, 0], ['free', 30, 0], ['Goodbye Song', 15, 0]],
    traits: '4-day week, 3 groups, 30-minute blocks with no gaps, 24h times, no lunch at all, "Swim Test" activity beside "Swim", blank cells.' },
  { slug: 's04-by-day-6day-large', layout: 'byDay', dayCount: 6, groupCount: 24, divisions: 6, clock: '12', start: 510, activityCount: 35, poolOffset: 8, splitEvery: 29, extraGroup: 'CIT', wrapAt: 14,
    plan: [['Arrival', 15], ['Flag Raising', 10], ['free', 60], ['free', 60], ['LUNCH', 45], ['LUNCH', 45], ['free', 60], ['free', 60], ['Dismissal', 15, 0]],
    events: [{ name: 'Trip Day', kind: 'single', days: [5], row: 2, groups: 'all' }, { name: 'Color Games', kind: 'weekly', days: [3], row: 6, groups: 'all' }],
    traits: '6-day week, 24 groups + a lone CIT group in 7 divisions, 60-minute blocks, two lunch waves (CIT lunches with wave 2), 35 activities, split cells ("A - B"), single-day Saturday special and a weekly Thursday special.' },
  { slug: 's05-by-day-tiny-early', layout: 'byDay', dayCount: 5, groupCount: 2, divisions: 1, clock: '24', start: 450, activityCount: 6, typos: { Archery: 2 },
    plan: [['Reveille', 10, 0], ['free', 20, 0], ['free', 20, 0], ['free', 20, 0], ['LUNCH', 20, 0], ['free', 20, 0], ['free', 20, 0], ['Taps', 10, 0]],
    traits: 'Smallest camp: 2 groups, 7:30 start, 20-minute blocks, 24h times, one lunch wave, "Archary" typo.' },
  { slug: 's06-by-day-40-groups-late', layout: 'byDay', dayCount: 5, groupCount: 40, divisions: 8, clock: '12', start: 540, activityCount: 40, poolOffset: 12, colliders: ['Lunch Bunch', 'Swim Test'], wrapAt: 14,
    plan: [['Arrival', 15], ['free', 50], ['free', 50], ['LUNCH', 50], ['LUNCH', 50], ['LUNCH', 50], ['free', 50], ['free', 50], ['free', 50], ['Dismissal', 15, 0]],
    events: [{ name: 'Closing Ceremony', kind: 'single', days: [4], row: 8, groups: 'all' }],
    traits: 'Largest: 40 groups, 8 divisions, 50-minute blocks from 9:00 to a 4:55pm finish, three lunch waves, 40 activities including both colliding names, single-day Friday finale.' },
  { slug: 's07-by-group-3-divisions', layout: 'byGroup', dayCount: 5, groupCount: 8, divisions: 3, clock: '12', start: 555, activityCount: 15, poolOffset: 5,
    plan: [['Opening', 20], ['free', 45], ['free', 45], ['LUNCH', 40], ['LUNCH', 40], ['free', 45], ['free', 45], ['Closing', 15, 0]],
    events: [{ name: 'Swim Meet', kind: 'weekly', days: [4], row: 1, groups: 'all' }],
    traits: 'campA-style by-group pages with "Unit - Bunk" titles: 8 bunks in 3 units, two lunch waves, weekly Friday Swim Meet.' },
  { slug: 's08-by-group-24h-wrapped', layout: 'byGroup', dayCount: 4, groupCount: 12, divisions: 4, clock: '24', start: 540, activityCount: 20, poolOffset: 10, typos: { Music: 2 }, wrapAt: 12, blankEvery: 17,
    plan: [['Check In', 15, 0], ['free', 30, 0], ['free', 30, 0], ['free', 30, 0], ['free', 30, 0], ['free', 30, 0], ['free', 30, 0], ['Check Out', 15, 0]],
    traits: 'By-group, 4-day week, 12 bunks in 4 units, 30-minute blocks, 24h times, no lunch, narrow columns so long names wrap onto two lines, "Musik" typo, blank cells.' },
  { slug: 's09-by-group-6day-except', layout: 'byGroup', dayCount: 6, groupCount: 20, divisions: 5, clock: '12', start: 530, activityCount: 30, poolOffset: 20, splitEvery: 41, extraGroup: 'Counselor Aides',
    plan: [['Arrival', 15], ['Flag Raising', 10], ['free', 50], ['free', 50], ['LUNCH', 45], ['free', 50], ['free', 40], ['Dismissal', 15, 0]],
    events: [{ name: 'Campfire', kind: 'single', days: [3], row: 5, groups: 'all' }],
    traits: '6-day by-group, 20 bunks in 5 units plus a lone "Counselor Aides" group, uneven 40/50-minute blocks, one lunch wave, split cells, single-day Thursday Campfire.' },
  { slug: 's10-by-group-sun-thu-early', layout: 'byGroup', days: SUN_THU, groupCount: 4, divisions: 2, clock: '12', start: 450, activityCount: 10, colliders: ['Lunch Bunch'],
    plan: [['Opening', 15, 0], ['free', 60, 0], ['free', 60, 0], ['LUNCH', 45, 0], ['free', 60, 0], ['free', 60, 0], ['Closing', 15, 0]],
    traits: 'Sunday-to-Thursday week starting 7:30, 4 bunks in 2 units, 60-minute blocks, one lunch wave, "Lunch Bunch" activity.' },
  { slug: 's11-daysheet-5d-small', layout: 'daySheet', dayCount: 5, groupCount: 6, divisions: 2, clock: 'ampm', start: 540, activityCount: 8, colliders: ['Lunch Bunch'],
    plan: [['Sign In', 20, 10], ['free', 40, 10], ['free', 40, 10], ['LUNCH', 40, 10], ['free', 40, 10], ['Pick Up', 20, 0]],
    traits: 'campC-style day sheets (unlabeled time column, AM/PM, a room under each activity), 6 groups with positional codes 1A-2B, one lunch wave.' },
  { slug: 's12-daysheet-4d-late', layout: 'daySheet', dayCount: 4, groupCount: 10, divisions: 3, clock: 'ampm', start: 620, activityCount: 18, poolOffset: 7,
    plan: [['Sign In', 20, 10], ['free', 45, 5], ['free', 45, 5], ['LUNCH', 40, 10], ['LUNCH', 40, 10], ['free', 45, 5], ['free', 45, 5], ['free', 45, 5], ['free', 45, 5], ['Pick Up', 30, 0]],
    events: [{ name: 'Theme Day', kind: 'weekly', days: [3], row: 1, groups: 'all' }],
    traits: 'Day sheets, 4-day week, 10 groups, two lunch waves, 10:20 start to a 6:00pm finish, weekly Thursday Theme Day.' },
  { slug: 's13-daysheet-16-splits', layout: 'daySheet', dayCount: 5, groupCount: 16, divisions: 4, clock: 'ampm', start: 525, activityCount: 25, poolOffset: 14, splitEvery: 19, typos: { Music: 2 },
    plan: [['Sign In', 20, 10], ['free', 45, 5], ['free', 45, 5], ['LUNCH', 35, 5], ['LUNCH', 35, 5], ['LUNCH', 35, 5], ['free', 45, 5], ['free', 45, 5], ['Pick Up', 20, 0]],
    events: [{ name: 'Library', kind: 'alternate', days: [0, 2, 4], row: 1, groups: 'all', except: ['4D'] }],
    traits: 'Day sheets, 16 groups, three lunch waves, split cells, "Musik" typo, every-other-day Library for all groups except 4D.' },
  { slug: 's14-by-day-period-24h', layout: 'byDayPeriod', dayCount: 5, groupCount: 9, divisions: 3, clock: '24', start: 540, activityCount: 14, poolOffset: 25,
    plan: [['Morning Meeting', 15], ['free', 45], ['free', 45], ['LUNCH', 40], ['LUNCH', 40], ['free', 45], ['free', 45], ['Closing Circle', 15, 0]],
    events: [{ name: 'Swim', kind: 'weekly', days: [2], row: 1, groups: 'all' }],
    traits: 'By-day pages headed "Period" with upper-case day titles, 24h times, 9 groups in 3 divisions, two lunch waves, and a weekly all-camp event whose name is also an activity ("Swim").' },
  { slug: 's15-by-day-period-6day-nolunch', layout: 'byDayPeriod', dayCount: 6, groupCount: 18, divisions: 6, clock: '24', start: 495, activityCount: 30, poolOffset: 30, blankEvery: 23, wrapAt: 14, colliders: ['Swim Test'],
    plan: [['Arrival', 15, 0], ['free', 30, 10], ['free', 45, 5], ['free', 35, 5], ['Snack', 20, 5], ['free', 45, 5], ['free', 30, 10], ['free', 55, 5], ['Dismissal', 15, 0]],
    traits: 'By-day "Period" pages, 6-day week, 18 groups in 6 divisions, uneven 30/35/45/55-minute blocks, no lunch, daily Snack event, blank cells, "Swim Test" activity.' },
]

// Multi-block spans, field trips (some groups, part of a day), all-day special days and electives, layered onto
// the base camps. `divs` picks divisions by index, `idx` picks groups by index, `except` is "everyone but".
const ROPES = 'Ropes Course'
const WILD = 'Wilderness Skills'
const EXTRA = {
  's01-by-day-small-5d': {
    spans: [{ name: ROPES, n: 2, form: 'repeat', row: 4, days: [1, 3], groups: { divs: [1] } }],
    trips: [{ name: 'Museum Trip', day: 2, rows: [1, 2], groups: { divs: [1] } }],
  },
  's02-by-day-three-waves': {
    spans: [{ name: ROPES, n: 2, form: 'blank', row: 7, days: [3], groups: 'all' }],
    electives: [{ name: 'Chugim', form: 'header', rows: [3], days: [2], groups: 'all', offerings: ['Ceramics', 'Ropes', 'Drama', 'Chess Club'] }],
    allDay: [{ name: 'Color War Day', day: 4, groups: 'all' }],
  },
  's03-by-day-4day-24h-nolunch': {
    spans: [{ name: WILD, n: 3, form: 'repeat', row: 1, days: [1], groups: 'all' }],
    trips: [{ name: 'Farm Trip', day: 3, rows: [1, 2, 3, 4], groups: { idx: [0] } }],
  },
  's04-by-day-6day-large': {
    spans: [
      { name: ROPES, n: 2, form: 'repeat', row: 2, days: [1], groups: { divs: [0, 1] } },
      { name: WILD, n: 2, form: 'repeat', row: 6, days: [1, 2], groups: { divs: [2, 3] } },
    ],
    trips: [{ name: 'Aquarium Trip', day: 2, rows: [2, 3], groups: { divs: [4, 5] } }],
    allDay: [{ name: 'Games Day', day: 4, groups: { divs: [0, 1] } }],
    electives: [
      { name: 'Electives', form: 'header', rows: [7], days: [0, 3], groups: { divs: [4, 5] }, offerings: ['Pottery', 'Robotics'] },
      { name: 'Chugim', form: 'list', rows: [3], days: [4], groups: { divs: [2, 3] }, offerings: ['Ceramics', 'Kayaking', 'Yoga', 'Puppetry'] },
    ],
  },
  's05-by-day-tiny-early': {
    spans: [{ name: ROPES, n: 3, form: 'repeat', row: 1, days: [0], groups: 'all' }],
    trips: [{ name: 'Farm Trip', day: 3, rows: [5, 6], groups: { idx: [1] } }],
    allDay: [{ name: 'Games Day', day: 4, groups: 'all' }],
  },
  's06-by-day-40-groups-late': {
    spans: [
      { name: WILD, n: 3, form: 'repeat', row: 6, days: [1], groups: { divs: [6, 7] } },
      { name: ROPES, n: 2, form: 'blank', row: 1, days: [0, 2], groups: { divs: [0, 1] } },
    ],
    trips: [{ name: 'Aquarium Trip', day: 2, rows: [6, 7, 8], groups: { divs: [2, 3] } }],
    allDay: [{ name: 'Games Day', day: 3, groups: 'all' }],
    electives: [
      { name: 'Chugim', form: 'header', rows: [7], days: [0], groups: 'all', offerings: ['Ceramics', 'Ropes', 'Drama'] },
      { name: 'Outdoor Elective', form: 'list', rows: [6], days: [4], groups: { divs: [4, 5] }, offerings: ['Hiking', 'Fishing', 'Kayaking', 'Orienteering', 'Bocce'] },
    ],
  },
  's07-by-group-3-divisions': {
    spans: [{ name: ROPES, n: 2, form: 'repeat', row: 5, days: [1, 3], groups: { divs: [2] } }],
    trips: [{ name: 'Museum Trip', day: 2, rows: [1, 2], groups: { divs: [1] } }],
    electives: [{ name: 'Indoor Elective', form: 'header', rows: [6], days: [0], groups: { idx: [0, 1] }, offerings: ['Chess Club', 'Knitting'] }],
  },
  's08-by-group-24h-wrapped': {
    spans: [
      { name: WILD, n: 3, form: 'repeat', row: 1, days: [0, 2], groups: { divs: [0] } },
      { name: ROPES, n: 2, form: 'blank', row: 4, days: [1], groups: 'all' },
    ],
    allDay: [{ name: 'Games Day', day: 3, groups: { divs: [0, 1] } }],
    electives: [{ name: 'Electives', form: 'list', rows: [5], days: [2], groups: { divs: [2, 3] }, offerings: ['Chess Club', 'Robotics', 'Cooking'] }],
  },
  's09-by-group-6day-except': {
    spans: [{ name: ROPES, n: 2, form: 'repeat', row: 2, days: [1, 4], groups: { divs: [1, 2] } }],
    trips: [{ name: 'Aquarium Trip', day: 2, rows: [2, 3], groups: { divs: [0] } }],
    allDay: [{ name: 'Games Day', day: 5, groups: { except: ['Counselor Aides'] } }],
    electives: [{ name: 'Bechirot', form: 'header', rows: [6], days: [0, 2, 4], groups: 'all', offerings: ['Drama', 'Dance', 'Yoga'] }],
  },
  's10-by-group-sun-thu-early': {
    spans: [{ name: WILD, n: 2, form: 'repeat', row: 1, days: [1], groups: 'all' }],
    trips: [{ name: 'Farm Trip', day: 3, rows: [4, 5], groups: { divs: [1] } }],
    allDay: [{ name: 'Games Day', day: 4, groups: 'all' }],
  },
  's11-daysheet-5d-small': {
    spans: [{ name: ROPES, n: 2, form: 'repeat', row: 1, days: [2], groups: { divs: [1] } }],
    trips: [{ name: 'Museum Trip', day: 1, rows: [1, 2], groups: { divs: [0] } }],
    electives: [{ name: 'Electives', form: 'header', rows: [4], days: [4], groups: 'all', offerings: ['Ceramics', 'Drama'] }],
  },
  's12-daysheet-4d-late': {
    spans: [
      { name: WILD, n: 3, form: 'repeat', row: 5, days: [0], groups: { divs: [0] } },
      { name: ROPES, n: 2, form: 'blank', row: 7, days: [1, 2], groups: { divs: [1, 2] } },
    ],
    trips: [{ name: 'Aquarium Trip', day: 1, rows: [5, 6], groups: { divs: [0] } }],
    allDay: [{ name: 'Games Day', day: 0, groups: { divs: [1, 2] } }],
    electives: [{ name: 'Electives', form: 'list', rows: [8], days: [3], groups: { divs: [2] }, offerings: ['Pottery', 'Drama', 'Robotics'] }],
  },
  's13-daysheet-16-splits': {
    spans: [{ name: ROPES, n: 2, form: 'repeat', row: 6, days: [1, 3], groups: { divs: [0, 1] } }],
    trips: [{ name: 'Aquarium Trip', day: 2, rows: [6, 7], groups: { divs: [2] } }],
    allDay: [{ name: 'Games Day', day: 1, groups: { divs: [2, 3] } }],
    electives: [
      { name: 'Chugim', form: 'header', rows: [7], days: [4], groups: 'all', offerings: ['Ceramics', 'Ropes'] },
      { name: 'Chugim', form: 'list', rows: [2], days: [3], groups: { divs: [3] }, offerings: ['Ceramics', 'Pottery'] },
    ],
  },
  's14-by-day-period-24h': {
    spans: [{ name: ROPES, n: 2, form: 'repeat', row: 5, days: [0], groups: 'all' }],
    trips: [{ name: 'Museum Trip', day: 3, rows: [5, 6], groups: { divs: [1] } }],
    electives: [{ name: 'Elective', form: 'header', rows: [2], days: [0, 3], groups: { divs: [0] }, offerings: ['Chess Club', 'Garden', 'Yoga', 'Drama', 'Cooking'] }],
  },
  's15-by-day-period-6day-nolunch': {
    spans: [
      { name: WILD, n: 3, form: 'blank', row: 1, days: [0, 2, 4], groups: { divs: [0, 1] } },
      { name: ROPES, n: 3, form: 'repeat', row: 5, days: [1], groups: 'all' },
    ],
    trips: [{ name: 'Farm Trip', day: 3, rows: [1, 2], groups: { divs: [4, 5] } }],
    allDay: [{ name: 'Games Day', day: 5, groups: 'all' }],
    electives: [{ name: 'Electives', form: 'header', rows: [6], days: [3], groups: 'all', offerings: ['Pottery', 'Dance', 'Soccer'] }],
  },
}
for (const spec of SPECS) Object.assign(spec, EXTRA[spec.slug] ?? {})

const RENDER = { byDay: renderByDay, byDayPeriod: renderByDay, byGroup: renderByGroup, daySheet: renderDaySheet }
const manifest = []
const SIDE_DIR = path.join(HERE, 'special-days')
fs.mkdirSync(SIDE_DIR, { recursive: true })
const SIDE_CELLS = ['Opening Whistle', 'Relay Races', 'Lunch', 'Tug of War', 'Team Cheer', 'Awards', 'Cleanup Crew', 'Final Huddle', 'Wrap Up']
// A one-day file as a spreadsheet export would print it: one page, no day name anywhere, rows with no blank lines between.
function sideCar(camp, name, groupNames, heading) {
  const colW = Math.max(...groupNames.map((g) => g.length), 18) + 3
  const out = [`${' '.repeat(20)}${name}`, '', '   Time'.padEnd(18) + groupNames.map((g) => g.padEnd(colW)).join('').trimEnd()]
  camp.blocks.forEach((b, i) => out.push((label(b, camp.spec.clock)).padEnd(18) + groupNames.map(() => SIDE_CELLS[i % SIDE_CELLS.length].padEnd(colW)).join('').trimEnd()))
  return { text: out.join('\n') + '\n', heading }
}
const sidecars = []
for (const spec of SPECS) {
  const camp = build(spec)
  const text = RENDER[spec.layout](camp)
  const file = `${spec.slug}.txt`
  fs.writeFileSync(path.join(HERE, file), text)
  if (['s02-by-day-three-waves', 's05-by-day-tiny-early', 's09-by-group-6day-except'].includes(spec.slug)) {
    for (const ev of camp.events.filter((e) => e.kind === 'allday')) {
      const sc = sideCar(camp, ev.name, ev.groups.slice(0, 6), ev.name)
      const f = `${spec.slug.slice(0, 3)}-${ev.name.toLowerCase().replace(/ /g, '-')}.txt`
      fs.writeFileSync(path.join(SIDE_DIR, f), sc.text)
      sidecars.push({ slug: spec.slug, file: `special-days/${f}`, name: ev.name, groups: ev.groups.slice(0, 6), blocks: camp.blocks.length })
    }
  }
  manifest.push({
    slug: spec.slug,
    file,
    layout: spec.layout,
    traits: spec.traits,
    days: camp.days,
    groups: camp.names,
    divisions: camp.divisions,
    clock: spec.clock,
    blocks: camp.blocks.map((b) => ({ label: label(b, spec.clock), minutes: b.e - b.s, kind: b.kind === 'free' ? 'activity' : b.kind === 'LUNCH' ? 'lunch' : 'event' })),
    firstStart: clockText(camp.blocks[0].s, '24'),
    lastEnd: clockText(camp.blocks.at(-1).e, '24'),
    lunchWaves: camp.waveGroups.map((g, w) => ({ name: camp.waveName(w), block: label(camp.blocks[camp.lunchRows[w]], spec.clock), groups: g })),
    spans: camp.spans.map((sp) => ({ name: sp.name, blocks: sp.n, form: sp.form, days: sp.days, groups: sp.groups, rows: Array.from({ length: sp.n }, (_, k) => label(camp.blocks[sp.row + k], spec.clock)) })),
    electives: camp.electives.map((el) => ({ name: el.name, form: el.form, days: el.days, groups: el.groups, rows: el.rows.map((r) => label(camp.blocks[r], spec.clock)), offerings: el.offerings })),
    events: camp.events.map((e) => ({ name: e.name, kind: e.kind, days: e.days, blocks: e.rows.map((r) => label(camp.blocks[r], spec.clock)), groups: e.groups.length === camp.names.length ? 'all' : e.groups, ...(e.allExcept ? { allExcept: e.allExcept } : {}) })),
    activities: [...camp.pool, ...new Set(camp.spans.map((sp) => sp.name))],
    typos: Object.entries(spec.typos ?? {}).map(([from]) => ({ canonical: from, variant: TYPOS[from] })),
    counts: camp.counts,
  })
}
fs.writeFileSync(path.join(HERE, 'manifest.json'), JSON.stringify({ camps: manifest, specialDayFiles: sidecars }, null, 2) + '\n')

const LAYOUT_NAME = { byDay: 'by-day (campB shape)', byDayPeriod: 'by-day, "Period" header, upper-case titles', byGroup: 'by-group (campA shape)', daySheet: 'day sheet (campC shape)' }
const rows = manifest.map((m, i) => `| ${i + 1} | \`${m.file}\` | ${LAYOUT_NAME[m.layout]} | ${m.days.length} | ${m.groups.length} | ${m.divisions.length} | ${m.activities.length} | ${m.lunchWaves.length || 'none'} | ${m.firstStart}-${m.lastEnd} |`)
const detail = manifest.map((m, i) => [
  `### ${i + 1}. \`${m.file}\``, '', m.traits, '',
  `- Days: ${m.days.join(', ')}`,
  `- Groups (${m.groups.length}): ${m.groups.join(', ')}`,
  `- Lunch: ${m.lunchWaves.length ? m.lunchWaves.map((w) => `${w.name} at ${w.block} for ${w.groups.length === m.groups.length ? 'all groups' : w.groups.join(', ')}`).join('; ') : 'none printed'}`,
  `- Events (should classify as fixed or recurring, never as activities): ${m.events.filter((e) => !['lunch', 'trip', 'allday'].includes(e.kind)).map((e) => `${e.name} (${e.kind}, ${e.days.length === m.days.length ? 'every day' : e.days.join('/')}${e.allExcept ? `, all but ${e.allExcept.join('/')}` : ''})`).join('; ') || 'none'}`,
  `- Multi-block spans (one session each toward min_per_week): ${m.spans.map((sp) => `${sp.name} x${sp.blocks} blocks (${sp.form === 'repeat' ? 'name printed in every block' : 'name printed once, later blocks blank'}) on ${sp.days.join('/')} at ${sp.rows[0]} for ${sp.groups.length === m.groups.length ? 'all groups' : sp.groups.join(', ')}`).join('; ') || 'none'}`,
  `- Field trips (some groups, part of a day): ${m.events.filter((e) => e.kind === 'trip').map((e) => `${e.name} on ${e.days.join('/')} at ${e.blocks.join(', ')} for ${e.groups.join(', ')}`).join('; ') || 'none'}`,
  `- All-day special days: ${m.events.filter((e) => e.kind === 'allday').map((e) => `${e.name} on ${e.days.join('/')} for ${e.groups === 'all' ? 'the whole camp' : e.allExcept ? `everyone but ${e.allExcept.join(', ')}` : e.groups.join(', ')}`).join('; ') || 'none'}`,
  `- Electives: ${m.electives.map((el) => `${el.name} (${el.form === 'list' ? 'cell lists the choices' : 'cell prints only the elective word'}; ${el.offerings.length} choices: ${el.offerings.join('/')}) on ${el.days.join('/')} at ${el.rows.join(', ')} for ${el.groups.length === m.groups.length ? 'all groups' : el.groups.join(', ')}`).join('; ') || 'none'}`,
  `- Activities (${m.activities.length}): ${m.activities.join(', ')}`,
  `- Deliberate noise: ${m.counts.blank} blank cells, ${m.counts.split} split cells, ${m.counts.typo} typo cells${m.typos.length ? ` (${m.typos.map((t) => `${t.variant} for ${t.canonical}`).join(', ')})` : ''}`,
  '',
].join('\n')).join('\n')

fs.writeFileSync(path.join(HERE, 'README.md'), [
  '---',
  'title: "Synthetic camp corpus: 15 fictional schedules"',
  'document_type: reference',
  'status: active',
  'created: 2026-10-11',
  'governing_docs: [docs/work/specs/samples/INGESTION_SAMPLES.md]',
  'archive_when: the corpus is folded into the shared sample set or the importer stops reading text grids',
  '---', '',
  '# Synthetic camp corpus (15 fictional schedules)', '',
  'Every name is invented; nothing here describes a real camp, person or organisation. Files are generated by',
  '`generate.mjs` in this directory (`node docs/work/specs/samples/synthetic/generate.mjs`), which also writes',
  '`manifest.json`, the machine-readable expected facts that `electron/syntheticCamps.harness.integration.test.js`',
  'checks the importer against. Do not hand-edit the generated files; edit the generator and rerun it.', '',
  'The four layouts are exactly the shapes `src/ingest/textGrid.js` parses (see `docs/work/specs/samples/` for the',
  'real-shaped originals): by-day pages with groups across, by-group pages with days across (labelled time column),',
  'a "Period"-labelled by-day variant with 24h times, and unlabeled-time-column day sheets with AM/PM and a room line.', '',
  '`docs/work/specs/samples/synthetic/` is not covered by `ingestPassExclusivity.allSamples.integration.test.js`, which globs',
  '`samples/*.txt` non-recursively; the synthetic harness asserts the same exclusivity invariant on all 15.', '',
  'What each added feature looks like in a text grid (the importer reads nothing richer from text):',
  '- Multi-block spans: the activity name printed in every block of the span ("repeat") or only in the first with the',
  '  later blocks blank ("blank", how a merged cell extracts). An XLSX merge (`row.blockSpans`) cannot be expressed here.',
  '- Field trips: a trip name in the same consecutive blocks of one day for some groups. All-day special days: one name',
  '  in every block of one day, for the whole camp or for a subset of groups. The importer has no special-event syntax',
  '  for a weekly grid, so these are plain cells; the manifest records what SHOULD result.',
  '- Electives: the cell prints only the elective word ("Electives", "Chugim", "Bechirot", "Elective", "Indoor Elective",',
  '  "Outdoor Elective", the words `isElectiveHeaderText` knows) or a slash-separated list of the choices. The offerings of',
  '  a header-word elective are listed only in the manifest.', '',
  '`repro/` holds eight minimal grids, one per scorecard root cause. Run any of them with',
  '`SYNTHETIC_REPRO=docs/work/specs/samples/synthetic/repro/<file> npx vitest run electron/syntheticCamps.harness.integration.test.js -t "prints the import"`.', '',
  'Three one-day special-day files sit in `special-days/` (a Games Day or Color War Day as a standalone sheet: one page, no day name,',
  'groups across). They exist to test whether the importer can read special events from a file; see the scorecard.', '',
  '| # | File | Layout | Days | Groups | Divisions | Activities | Lunch waves | Day span |', '|---|---|---|---|---|---|---|---|---|',
  ...rows, '', '## Expected facts per camp', '', detail,
].join('\n'))
console.log(`wrote ${manifest.length} camps`)
