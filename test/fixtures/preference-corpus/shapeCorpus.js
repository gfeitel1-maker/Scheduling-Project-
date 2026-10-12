// T282 — the SHAPE-PARAMETERISED preference corpus, with ground truth.
//
// docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md §8, §8.0
//
// What the older probe corpus (scripts/fixtures/make-preference-corpus.mjs) could not do is say what
// a file SHOULD import: it measured what happened and a person read it. Here every case carries its
// own truth (which camper ranked which activity at which rank), built by the same code that wrote the
// file, so the acceptance numbers are computed by comparing the database with the truth, not by eye.
//
// Pure: it returns rows and truth, it writes nothing. No real camp data: every camper name comes from
// synthetic-names.json (asserted by electron/preferenceCorpusAcceptance.integration.test.js) and every
// activity from the corpus vocabulary below.
import fs from 'node:fs'
import path from 'node:path'

const DIR = path.join(process.cwd(), 'test/fixtures/preference-corpus')
export const SYNTHETIC_NAMES = JSON.parse(fs.readFileSync(path.join(DIR, 'synthetic-names.json'), 'utf8')).names

export const CATALOG_ACTIVITIES = [
  'Swim', 'Archery', 'Ceramics', 'Woodworking', 'Basketball', 'Drama', 'Nature',
  'Photography', 'Rock Climbing', 'Gaga', 'Dance', 'Cooking', 'Soccer', 'Tennis',
  'Arts And Crafts', 'Sailing', 'Yoga', 'Fishing', 'Hockey', 'Music',
]
export const CATALOG_GROUPS = ['Upper Division', 'Lower Division', 'Middle Division']

// Every shape class the ADR names (§1, §8). H (a camp-platform portal export) is deliberately NOT
// modelled: no vendor publishes a column-level spec and the owner closed the question of a sample
// (ADR §9 Q1), so a fabricated layout would be a green suite about a format nobody has seen.
export const SHAPE_CLASSES = Object.freeze({
  A: 'a camper’s own planner grid (days x periods)',
  B: 'a flat ranked list, one row per camper',
  C: 'a planner grid and a ranked block on one page',
  D: 'an offerings menu (what is offered, not what was chosen)',
  E: 'prose or compound rank headers',
  F: 'packed or unordered choice cells',
  G: 'a workbook whose preferences are not on the first tab',
  NEW: 'shapes no prior design named (long form, inverted matrix, split names, decoy columns)',
})
export const EXCLUDED_CLASSES = Object.freeze({ H: 'camp-platform portal export: no spec and no sample exists (ADR §9 Q1)' })

const act = (i) => CATALOG_ACTIVITIES[i % CATALOG_ACTIVITIES.length]
const name = (i) => SYNTHETIC_NAMES[i % SYNTHETIC_NAMES.length]
const DIVISION = (i) => CATALOG_GROUPS[i % 3]
const ORDINAL = ['First', 'Second', 'Third', 'Fourth', 'Fifth']

// A camper's ranked picks: rank r (1-based) -> activity. `seed` spreads campers over the catalog.
const picks = (i, nRanks, seed = 0) => Array.from({ length: nRanks }, (_, r) => act(i * 3 + r + seed))

function truthOf(campers) {
  return {
    campers: campers.map((c) => c.name),
    prefs: campers.flatMap((c) => c.picks.map((label, r) => ({ camper: c.name, label, rank: c.unranked ? null : r + 1 })).filter((p) => p.label)),
  }
}

function roster(n, nRanks, { offset = 0, seed = 0 } = {}) {
  return Array.from({ length: n }, (_, i) => ({ name: name(i + offset), division: DIVISION(i), picks: picks(i, nRanks, seed) }))
}

function ranked(campers, { rankHeader = (r) => `#${r}`, nameHeader = 'Camper Name', withId = false, withDivision = true, order = null } = {}) {
  const nRanks = campers[0].picks.length
  const rankOrder = order ?? Array.from({ length: nRanks }, (_, r) => r)
  const head = [...(withId ? ['Camper ID'] : []), nameHeader, ...(withDivision ? ['Division'] : []), ...rankOrder.map((r) => rankHeader(r + 1))]
  return [head, ...campers.map((c, i) => [
    ...(withId ? [`SYN-${1000 + i}`] : []), c.name, ...(withDivision ? [c.division] : []), ...rankOrder.map((r) => c.picks[r] ?? ''),
  ])]
}

// Every builder takes the size parameters and returns { rows | sheets, truth, format }.
const SHAPES = [
  { shape: 'B-canonical', cls: 'B', build: ({ n, k }) => { const c = roster(n, k); return { rows: ranked(c), truth: truthOf(c) } } },
  { shape: 'B-external-id', cls: 'B', build: ({ n, k }) => { const c = roster(n, k); return { rows: ranked(c, { withId: true }), truth: truthOf(c) } } },
  { shape: 'B-no-division', cls: 'B', build: ({ n, k }) => { const c = roster(n, k); return { rows: ranked(c, { withDivision: false }), truth: truthOf(c) } } },
  { shape: 'B-ranks-out-of-order', cls: 'B', build: ({ n, k }) => { const c = roster(n, k); return { rows: ranked(c, { order: [...Array(k).keys()].reverse() }), truth: truthOf(c) } } },
  { shape: 'B-spaced-rank-headers', cls: 'B', build: ({ n, k }) => { const c = roster(n, k); return { rows: ranked(c, { rankHeader: (r) => (r % 2 ? `# ${r}` : ` #${r} `) }), truth: truthOf(c) } } },
  { shape: 'B-bare-student-header', cls: 'B', build: ({ n, k }) => { const c = roster(n, k); return { rows: ranked(c, { nameHeader: 'Student' }), truth: truthOf(c) } } },
  { shape: 'B-title-rows-above', cls: 'B', build: ({ n, k }) => { const c = roster(n, k); return { rows: [['Elective Selection'], ['Summer Session', ''], ...ranked(c)], truth: truthOf(c) } } },
  { shape: 'B-footer-rows-below', cls: 'B', build: ({ n, k }) => { const c = roster(n, k); return { rows: [...ranked(c), [], ['Total Campers', String(n)], ['Please Return', 'by June 1'], ['Camp Office Use Only']], truth: truthOf(c) } } },
  { shape: 'B-blank-ranks', cls: 'B', build: ({ n, k }) => {
    const c = roster(n, k)
    c[1].picks = c[1].picks.map(() => '')
    c[2].picks[1] = ''
    return { rows: ranked(c), truth: truthOf(c) }
  } },
  { shape: 'B-optout-and-comments', cls: 'B', build: ({ n, k }) => {
    const c = roster(n, k)
    const rows = ranked(c)
    rows[0].push('Opt Out of Instructional Swim', 'Additional Comments')
    rows.slice(1).forEach((r, i) => r.push(i % 3 === 0 ? 'Yes' : '', i % 4 === 0 ? 'Please keep with a friend' : ''))
    return { rows, truth: truthOf(c) }
  } },
  { shape: 'E-prose-rank-headers', cls: 'E', build: ({ n, k }) => { const c = roster(n, k); return { rows: ranked(c, { rankHeader: (r) => `${ORDINAL[r - 1]} Choice` }), truth: truthOf(c) } } },
  { shape: 'E-choice-n-headers', cls: 'E', build: ({ n, k }) => { const c = roster(n, k); return { rows: ranked(c, { rankHeader: (r) => `Choice ${r}` }), truth: truthOf(c) } } },
  { shape: 'F-unordered-set', cls: 'F', build: ({ n, k }) => {
    const c = roster(n, k).map((x) => ({ ...x, unranked: true }))
    return { rows: [['Camper Name', 'Division', 'Activities Chosen'], ...c.map((x) => [x.name, x.division, x.picks.join(', ')])], truth: truthOf(c) }
  } },
  { shape: 'NEW-split-name-columns', cls: 'NEW', build: ({ n, k }) => {
    const c = roster(n, k)
    return { rows: [['First Name', 'Last Name', 'Division', ...c[0].picks.map((_, r) => `#${r + 1}`)], ...c.map((x) => [...x.name.split(' '), x.division, ...x.picks])], truth: truthOf(c) }
  } },
  { shape: 'NEW-tidy-long', cls: 'NEW', build: ({ n, k }) => {
    const c = roster(n, k)
    return { rows: [['Camper Name', 'Choice Rank', 'Activity Name'], ...c.flatMap((x) => x.picks.map((a, r) => [x.name, String(r + 1), a]))], truth: truthOf(c) }
  } },
  { shape: 'NEW-inverted-matrix', cls: 'NEW', build: ({ n, k }) => {
    const acts = CATALOG_ACTIVITIES.slice(0, Math.max(8, k + 2))
    const c = roster(n, k).map((x, i) => ({ ...x, picks: Array.from({ length: k }, (_, r) => acts[(i + r) % acts.length]) }))
    const rows = [['Camper Name', 'Division', ...acts], ...c.map((x) => [x.name, x.division, ...acts.map((a) => { const r = x.picks.indexOf(a); return r < 0 ? '' : String(r + 1) })])]
    return { rows, truth: truthOf(c) }
  } },
  { shape: 'NEW-counselor-decoy-column', cls: 'NEW', build: ({ n, k }) => {
    const c = roster(n, k)
    return { rows: [['Child Name', 'Counselor Name', ...c[0].picks.map((_, r) => `#${r + 1}`)], ...c.map((x, i) => [x.name, name(i + 40), ...x.picks])], truth: truthOf(c) }
  } },
  { shape: 'D-offerings-menu', cls: 'D', build: () => {
    const days = ['Monday', 'Tuesday', 'Wednesday']
    const rows = [['Period', ...days], ...[1, 2, 3].map((p) => [`Period ${p}`, ...days.map((_, d) => `${act(p * 4 + d)}, ${act(p * 4 + d + 1)}`)])]
    return { rows, truth: { campers: [], prefs: [] } }
  } },
  { shape: 'G-preferences-on-tab-2', cls: 'G', build: ({ n, k }) => {
    const c = roster(n, k)
    return { sheets: [['Instructions', [['Please fill in the Selections tab'], ['Return by June 1']]], ['Selections', ranked(c)]], truth: truthOf(c) }
  } },
  { shape: 'A-planner-grid', cls: 'A', grid: true, build: ({ label }) => {
    const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
    const rows = [['Period', ...days], ...[1, 2, 3, 4].map((p) => [`Period ${p}`, ...days.map((_, d) => act(p * 5 + d))])]
    const labels = [...new Set(rows.slice(1).flatMap((r) => r.slice(1)))]
    return { rows, truth: { campers: [label], prefs: labels.map((l) => ({ camper: label, label: l, rank: '*' })) } }
  } },
  { shape: 'C-grid-plus-ranked-block', cls: 'C', grid: true, build: ({ label }) => {
    const days = ['Monday', 'Tuesday', 'Wednesday']
    const grid = [['Period', ...days], ...[1, 2, 3].map((p) => [`Period ${p}`, ...days.map((_, d) => act(p * 3 + d))])]
    const c = roster(3, 3, { offset: 20 })
    const rows = [...grid, [], ['Next Choices'], ...ranked(c, { withDivision: false })]
    const gridLabels = [...new Set(grid.slice(1).flatMap((r) => r.slice(1)))]
    return {
      rows,
      truth: {
        campers: [label, ...c.map((x) => x.name)],
        prefs: [...gridLabels.map((l) => ({ camper: label, label: l, rank: '*' })), ...truthOf(c).prefs],
      },
    }
  } },
]

const SIZES = [{ n: 6, k: 3 }, { n: 12, k: 5 }]
const FORMATS = ['csv', 'tsv', 'xlsx']

/**
 * Every case in the corpus: one per (shape, size), the formats rotated across them so each format
 * meets every class without tripling the run. Ids are stable, so a metric names the same files twice.
 */
export function buildCorpus() {
  const cases = []
  let f = 0
  for (const s of SHAPES) {
    for (const [si, size] of SIZES.entries()) {
      if (s.grid && si > 0) continue
      const id = `${s.shape}-${size.n}x${size.k}`
      const format = s.cls === 'G' ? 'xlsx' : FORMATS[f++ % FORMATS.length]
      const built = s.build({ ...size, label: id })
      cases.push({ id, shape: s.shape, cls: s.cls, grid: Boolean(s.grid), format, ...built })
    }
  }
  return cases
}

/**
 * The re-import cases (§8's idempotency and drift rows): one database, imported in order.
 * The drifted second file renames one rank column and adds a camper; it must import what IT says.
 */
export function buildReimportSequence() {
  const base = roster(8, 3)
  const drifted = [...base, { name: name(30), division: DIVISION(0), picks: picks(30, 3) }]
  return [
    { id: 'reimport-first', rows: ranked(base), truth: truthOf(base), format: 'csv' },
    { id: 'reimport-same-bytes', rows: ranked(base), truth: truthOf(base), format: 'csv' },
    { id: 'reimport-drifted', rows: ranked(drifted, { rankHeader: (r) => (r === 3 ? 'Third Choice' : `#${r}`) }), truth: truthOf(drifted), format: 'csv' },
  ]
}
