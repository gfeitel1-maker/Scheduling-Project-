// T282 / T278 round 3 — the shape-parameterised probe corpus.
//
// docs/adr/2026-09-27-elective-preference-etl-canonical-record-and-learned-axis-binding.md
// sections 1, 4, 8, 8.0; docs/work/tickets/T282-preference-import-corpus-and-acceptance-metrics.md
//
// WHAT THIS IS FOR, AND THE ORDER THAT MAKES IT EVIDENCE. The corpus is written
// BEFORE any reader or adapter is built for it, and is run against unmodified
// code. That order is the whole point: a corpus authored after the adapters
// measures whether two things the same author wrote in the same round agree
// with each other (Red Hat round 2, RISK 5). Run first, fix nothing, report.
//
// SYNTHETIC IDENTITIES ONLY. Every camper name comes from
// test/fixtures/preference-corpus/synthetic-names.json, and
// test/preferenceCorpusNames.test.js fails if any probe file contains a
// person-name-shaped cell that is not on that list or on the hand-reviewed
// vocabulary. scanPrivacy cannot match an unstructured personal name and
// security-gate.js path-scans binaries without reading them, so that test is
// the only real control here (ADR 8.0).
//
// SHAPE CLASS H IS ABSENT ON PURPOSE. No camp platform publishes a
// column-level spec for an elective export and no sample exists. A fabricated
// CampMinder layout would be a green suite describing a format nobody has seen.
// The owner has closed the question of obtaining one (ADR 9 Q1); H stays
// unmodelled rather than invented.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as XLSX from 'xlsx'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const DIR = path.join(ROOT, 'test/fixtures/preference-corpus')
const PROBES = path.join(DIR, 'probes')

const NAMES = JSON.parse(fs.readFileSync(path.join(DIR, 'synthetic-names.json'), 'utf8')).names

const ACT = [
  'Swim', 'Archery', 'Ceramics', 'Woodworking', 'Basketball', 'Drama', 'Nature',
  'Photography', 'Rock Climbing', 'Gaga', 'Dance', 'Cooking', 'Soccer', 'Tennis',
  'Arts And Crafts', 'Sailing', 'Yoga', 'Fishing', 'Hockey', 'Music',
]
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
const act = (i) => ACT[i % ACT.length]
const name = (i) => NAMES[i % NAMES.length]

// --- writers -------------------------------------------------------------
const csvCell = (v) => {
  const s = String(v ?? '')
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const writeCsv = (file, rows) =>
  fs.writeFileSync(path.join(PROBES, file), rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n')
// T251 — the same CSV writer, into a directory OTHER than probes/. Separate
// because `writeCsv` resolves against PROBES, which the emit step wipes on every
// run; a fixture outside that directory must not be deleted by a corpus rebuild.
const writeCsvTo = (dir, file, rows) => {
  const full = path.join(ROOT, dir)
  fs.mkdirSync(full, { recursive: true })
  fs.writeFileSync(path.join(full, file), rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n')
}
const writeTsv = (file, rows) =>
  fs.writeFileSync(path.join(PROBES, file), rows.map((r) => r.map((c) => String(c ?? '')).join('\t')).join('\n') + '\n')
const writeTxt = (file, text) => fs.writeFileSync(path.join(PROBES, file), text)
function writeXlsx(file, sheets) {
  const wb = XLSX.utils.book_new()
  for (const [sheetName, rows] of sheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), sheetName)
  }
  // XLSX.write to a buffer rather than writeFile: the ESM build has no bound
  // filesystem (set_fs is never called here), so writeFile throws.
  fs.writeFileSync(path.join(PROBES, file), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
}

// --- shape builders ------------------------------------------------------

// Kind 3: a flat global ranked list. The shape today's reader was built for.
function kind3(nCampers, nRanks, { header, withId = false, withDivision = true, offset = 0 } = {}) {
  const head = []
  if (withId) head.push('Camper ID')
  head.push(header?.nameHeader ?? 'Camper Name')
  if (withDivision) head.push('Division')
  for (let r = 1; r <= nRanks; r += 1) head.push(header?.rank ? header.rank(r) : `#${r}`)
  const rows = [head]
  for (let i = 0; i < nCampers; i += 1) {
    const row = []
    if (withId) row.push(`SYN-${String(1000 + i)}`)
    row.push(name(i + offset))
    if (withDivision) row.push(['Upper Division', 'Lower Division', 'Middle Division'][i % 3])
    for (let r = 0; r < nRanks; r += 1) row.push(act(i * 3 + r))
    rows.push(row)
  }
  return rows
}

// Kind 2 / A: a planner grid — periods in ROWS, days in COLUMNS, cells hold the
// camper's one chosen activity. Observed (ADR 1 finding 1).
function plannerGrid({ transposed = false, fixedRows = true } = {}) {
  const periods = [1, 2, 3, 4, 5, 6, 7]
  const cellFor = (p, d) => {
    if (!fixedRows) return act(p * 5 + d)
    if (p === 2) return 'Instructional Swim'
    if (p === 5) return 'Free Swim'
    if (p === 7) return 'Lunch'
    if (p === 1 && d === 0) return 'Bunk Unity'
    if (p === 6 && d === 4) return 'Shabbat'
    return act(p * 5 + d)
  }
  const grid = [['Period', ...DAYS]]
  for (const p of periods) grid.push([`Period ${p}`, ...DAYS.map((_, d) => cellFor(p, d))])
  if (!transposed) return grid
  return grid[0].map((_, c) => grid.map((r) => r[c]))
}

// Kind 1 / D: an offerings menu — same geometry, opposite meaning. Cells are
// SETS of what is available, laid out as two sub-columns per day under a
// merged day header (ADR 1 finding 6).
function offeringsMenu() {
  const head1 = ['Period']
  const head2 = ['']
  for (const d of DAYS) { head1.push(d, ''); head2.push('A', 'B') }
  const rows = [head1, head2]
  for (let p = 1; p <= 6; p += 1) {
    const row = [`Period ${p}`]
    for (let d = 0; d < DAYS.length; d += 1) {
      row.push(`${act(p * 7 + d)}, ${act(p * 7 + d + 1)}`, `${act(p * 7 + d + 2)}`)
    }
    rows.push(row)
  }
  return rows
}

// --- the probes ----------------------------------------------------------
// entry: 'pref'  -> scripts/preferenceSheetCli.js runPreferenceSheetCli (file bytes)
// entry: 'sched' -> scripts/ingestCli.js         runIngestCli           (file bytes)

const probes = []
const add = (p) => { probes.push(p); return p }

// ---- Kind 3, the shape the reader was built for
add({ id: 'P01', file: 'P01-kind3-canonical.csv', entry: 'pref', class: 'B',
  shape: 'Kind 3 global ranked list, #1..#3, name + division, no id',
  expect: 'reads correctly',
  write: () => writeCsv('P01-kind3-canonical.csv', kind3(12, 3)) })

add({ id: 'P02', file: 'P02-kind3-top25.csv', entry: 'pref', class: 'B',
  shape: 'Kind 3, #1..#25 priority gradient (ADR 1 finding 7)',
  expect: 'reads correctly; gradient meaning is not represented anywhere',
  write: () => writeCsv('P02-kind3-top25.csv', kind3(8, 25)) })

add({ id: 'P03', file: 'P03-kind3-prose-rank-headers.csv', entry: 'pref', class: 'E',
  shape: 'Kind 3 with realistic prose rank headers ("First Choice", "Second Choice", ...)',
  expect: 'RANK_HEADER is ^#\\s*(\\d+)$ so no rank column is found',
  write: () => writeCsv('P03-kind3-prose-rank-headers.csv',
    kind3(10, 3, { header: { rank: (r) => ['First Choice', 'Second Choice', 'Third Choice'][r - 1] } })) })

add({ id: 'P04', file: 'P04-kind3-bare-student-header.csv', entry: 'pref', class: 'B',
  shape: 'Kind 3 whose name column is headed simply "Student" (not "Student Name")',
  expect: 'NAME_HEADER requires (camper|student|child).*name or ^name$',
  write: () => writeCsv('P04-kind3-bare-student-header.csv', kind3(6, 3, { header: { nameHeader: 'Student' } })) })

add({ id: 'P05', file: 'P05-kind3-external-id.csv', entry: 'pref', class: 'B',
  shape: 'Kind 3 with a stable external camper id column',
  expect: 'reads correctly, identity keyed on the id',
  write: () => writeCsv('P05-kind3-external-id.csv', kind3(12, 3, { withId: true })) })

add({ id: 'P06', file: 'P06-kind3-partial-id.csv', entry: 'pref', class: 'B',
  shape: 'PARTIAL-ID residue (ADR 4.4): one child on two rows, one row carrying an id and one not',
  expect: 'two derived ids for one child, with nothing reported',
  write: () => {
    const rows = kind3(6, 3, { withId: true })
    rows.push(['', rows[1][1], rows[1][2], 'Sailing', 'Yoga', 'Fishing'])
    writeCsv('P06-kind3-partial-id.csv', rows)
  } })

add({ id: 'P07', file: 'P07-kind3-same-name-no-id.csv', entry: 'pref', class: 'B',
  shape: 'Two rows naming one child, no external id (ADR 4.4)',
  expect: 'sameNameCampers + contradictory ranks -> refused',
  write: () => {
    const rows = kind3(6, 3)
    rows.push([rows[1][0], 'Lower Division', 'Sailing', 'Yoga', 'Fishing'])
    writeCsv('P07-kind3-same-name-no-id.csv', rows)
  } })

add({ id: 'P08', file: 'P08-kind3-zero-choices.csv', entry: 'pref', class: 'B',
  shape: 'Kind 3 including a camper who ranked nothing at all, and blank middle ranks',
  expect: 'camper written with no preferences; nothing reported',
  write: () => {
    const rows = kind3(6, 3)
    rows[3][2] = ''; rows[3][3] = ''; rows[3][4] = ''
    rows[4][3] = ''
    writeCsv('P08-kind3-zero-choices.csv', rows)
  } })

add({ id: 'P09', file: 'P09-kind3-packed-cells.csv', entry: 'pref', class: 'F',
  shape: 'Packed multi-value cells: one #1 cell holding "Swim, Archery, Ceramics"',
  expect: 'the whole string becomes ONE choice label',
  write: () => {
    const rows = kind3(6, 3)
    for (let i = 1; i < rows.length; i += 1) rows[i][2] = `${act(i)}, ${act(i + 1)}, ${act(i + 2)}`
    writeCsv('P09-kind3-packed-cells.csv', rows)
  } })

add({ id: 'P10', file: 'P10-unordered-set-no-rank.csv', entry: 'pref', class: 'F',
  shape: 'An unranked SET (ADR 4.1): one column "Activities Chosen" holding a packed set, no ranks',
  expect: 'no rank columns found',
  write: () => {
    const rows = [['Camper Name', 'Division', 'Activities Chosen']]
    for (let i = 0; i < 6; i += 1) rows.push([name(i), 'Upper Division', `${act(i)}, ${act(i + 1)}, ${act(i + 2)}`])
    writeCsv('P10-unordered-set-no-rank.csv', rows)
  } })

add({ id: 'P11', file: 'P11-kind3-duplicate-rank-header.csv', entry: 'pref', class: 'B',
  shape: 'Header lists rank #1 twice',
  expect: 'header-level refusal before parsing',
  write: () => {
    const rows = kind3(6, 3)
    rows[0][3] = '#1'
    writeCsv('P11-kind3-duplicate-rank-header.csv', rows)
  } })

add({ id: 'P12', file: 'P12-header-not-first-row.csv', entry: 'pref', class: 'B',
  shape: 'Two title/junk rows above the real header row',
  expect: 'row 1 is taken as the header unconditionally',
  write: () => {
    const rows = kind3(8, 3)
    writeCsv('P12-header-not-first-row.csv', [['Activity Selection'], ['Upper Division', 'Summer'], ...rows])
  } })

add({ id: 'P13', file: 'P13-trailing-junk-rows.csv', entry: 'pref', class: 'B',
  shape: 'Kind 3 with a blank line and footer rows below the data',
  expect: 'footer rows become skippedRows or phantom campers',
  write: () => {
    const rows = kind3(8, 3)
    writeCsv('P13-trailing-junk-rows.csv', [...rows, [], ['Total Campers', '8'], ['Please Return', 'by June 1'], ['Camp Office Use Only']])
  } })

add({ id: 'P14', file: 'P14-kind3-tsv.tsv', entry: 'pref', class: 'B',
  shape: 'Kind 3 as TSV rather than CSV',
  expect: 'SheetJS sniffs the delimiter; reads correctly',
  write: () => writeTsv('P14-kind3-tsv.tsv', kind3(12, 3)) })

add({ id: 'P15', file: 'P15-kind3-xlsx.xlsx', entry: 'pref', class: 'B',
  shape: 'Kind 3 as a real .xlsx workbook',
  expect: 'reads correctly',
  write: () => writeXlsx('P15-kind3-xlsx.xlsx', [['Selections', kind3(12, 3)]]) })

add({ id: 'P16', file: 'P16-kind3-ranks-out-of-order.csv', entry: 'pref', class: 'B',
  shape: 'Rank columns physically ordered #3, #1, #2',
  expect: 'rankColumns sorted by rank; reads correctly',
  write: () => {
    const head = ['Camper Name', 'Division', '#3', '#1', '#2']
    const rows = [head]
    for (let i = 0; i < 8; i += 1) rows.push([name(i), 'Upper Division', act(i + 2), act(i), act(i + 1)])
    writeCsv('P16-kind3-ranks-out-of-order.csv', rows)
  } })

add({ id: 'P17', file: 'P17-kind3-spaced-rank-headers.csv', entry: 'pref', class: 'B',
  shape: 'Rank headers written "# 1", "#2 ", " #3" — whitespace variants',
  expect: 'the regex tolerates internal space after # and the cells are trimmed',
  write: () => {
    const rows = kind3(6, 3)
    rows[0][2] = '# 1'; rows[0][3] = '#2 '; rows[0][4] = ' #3'
    writeCsv('P17-kind3-spaced-rank-headers.csv', rows)
  } })

add({ id: 'P18', file: 'P18-kind3-optout-and-comments.csv', entry: 'pref', class: 'B',
  shape: 'Kind 3 plus the swim opt-out checkbox and the free-text comments box (ADR 4.3, 1 finding 7)',
  expect: 'both columns are silently dropped; the opt-out changes eligibility (1 finding 4)',
  write: () => {
    const rows = kind3(8, 3)
    rows[0].push('Opt Out of Instructional Swim', 'Additional Comments')
    for (let i = 1; i < rows.length; i += 1) {
      rows[i].push(i % 3 === 0 ? 'Yes' : '', i % 4 === 0 ? 'Please keep with a friend' : '')
    }
    writeCsv('P18-kind3-optout-and-comments.csv', rows)
  } })

// ---- Grids: planner (Kind 2), menu (Kind 1), and the mixed shapes
add({ id: 'P19', file: 'P19-planner-grid.csv', entry: 'pref', class: 'A',
  shape: 'Kind 2 planner grid, periods in rows / days in columns, through the PREFERENCE reader',
  expect: 'no name column and no #N header',
  write: () => writeCsv('P19-planner-grid.csv', plannerGrid()) })

add({ id: 'P20', file: 'P20-planner-grid-sched.xlsx', entry: 'sched', class: 'A',
  shape: 'The same Kind 2 planner grid through the SCHEDULE importer',
  expect: 'day-name columns present, so partitionSchedulePages accepts it as a schedule',
  write: () => writeXlsx('P20-planner-grid-sched.xlsx', [['Planner', plannerGrid()]]) })

add({ id: 'P21', file: 'P21-offerings-menu-sched.xlsx', entry: 'sched', class: 'D',
  shape: 'Kind 1 offerings menu, two sub-columns per day under a merged day header, packed cells',
  expect: 'a menu of what is OFFERED read as if it were somebody schedule',
  write: () => writeXlsx('P21-offerings-menu-sched.xlsx', [['Offerings Menu', offeringsMenu()]]) })

add({ id: 'P22', file: 'P22-offerings-menu-pref.csv', entry: 'pref', class: 'D',
  shape: 'The same Kind 1 offerings menu through the PREFERENCE reader',
  expect: 'refused for want of a name column',
  write: () => writeCsv('P22-offerings-menu-pref.csv', offeringsMenu()) })

add({ id: 'P23', file: 'P23-grid-plus-ranked-fallback.csv', entry: 'pref', class: 'C',
  shape: 'Kind 2 + Kind 3 on ONE page: the planner grid, then a "Next Five Choices" ranked block below it (ADR 1, class C)',
  expect: 'the grid header wins and the ranked block below is never seen',
  write: () => {
    const rows = plannerGrid()
    rows.push([], ['Next Five Choices'], ['Camper Name', '#1', '#2', '#3', '#4', '#5'])
    for (let i = 0; i < 4; i += 1) rows.push([name(i), act(i), act(i + 1), act(i + 2), act(i + 3), act(i + 4)])
    writeCsv('P23-grid-plus-ranked-fallback.csv', rows)
  } })

add({ id: 'P24', file: 'P24-transposed-planner-sched.xlsx', entry: 'sched', class: 'A',
  shape: 'Planner grid TRANSPOSED — days as rows, periods as columns',
  expect: 'detectOrientation should distinguish this from P20',
  write: () => writeXlsx('P24-transposed-planner-sched.xlsx', [['Planner', plannerGrid({ transposed: true })]]) })

add({ id: 'P25', file: 'P25-mixed-workbook-sched.xlsx', entry: 'sched', class: 'G',
  shape: 'Mixed workbook (T223 shape): offerings menu tab + camper selection tab + planner tab',
  expect: 'per-page partition keeps the selection tab out of extraction',
  write: () => writeXlsx('P25-mixed-workbook-sched.xlsx', [
    ['Offerings Menu', offeringsMenu()],
    ['Selections', kind3(10, 3)],
    ['Planner', plannerGrid()],
  ]) })

add({ id: 'P26', file: 'P26-mixed-workbook-pref.xlsx', entry: 'pref', class: 'G',
  shape: 'The SAME mixed workbook through the preference reader, whose reader is FIRST SHEET ONLY',
  expect: 'the actual preference tab is sheet 2 and is never read',
  write: () => writeXlsx('P26-mixed-workbook-pref.xlsx', [
    ['Offerings Menu', offeringsMenu()],
    ['Selections', kind3(10, 3)],
    ['Planner', plannerGrid()],
  ]) })

add({ id: 'P27', file: 'P27-two-row-merged-header-sched.xlsx', entry: 'sched', class: 'A',
  shape: 'Grid with a two-row header: day names on row 1 (merged, so blanks), clock times on row 2',
  expect: 'twoRowSplit should fold them',
  write: () => {
    const head1 = ['']; const head2 = ['Period']
    for (const d of DAYS) { head1.push(d, ''); head2.push('9:00', '10:15') }
    const rows = [head1, head2]
    for (let p = 1; p <= 5; p += 1) {
      const row = [`Period ${p}`]
      for (let d = 0; d < DAYS.length; d += 1) row.push(act(p * 4 + d), act(p * 4 + d + 1))
      rows.push(row)
    }
    writeXlsx('P27-two-row-merged-header-sched.xlsx', [['Grid', rows]])
  } })

add({ id: 'P28', file: 'P28-activity-named-like-a-day-sched.xlsx', entry: 'sched', class: 'A',
  shape: 'A grid whose activity names collide with day names ("Monday Night Live", "Friday Night Program", "Shabbat")',
  expect: 'day detection keys on cell text somewhere and may mis-locate the axis',
  write: () => {
    const rows = [['Period', ...DAYS]]
    for (let p = 1; p <= 5; p += 1) {
      rows.push([`Period ${p}`, ...DAYS.map((_, d) =>
        p === 3 ? 'Monday Night Live' : p === 4 ? 'Friday Night Program' : act(p * 5 + d))])
    }
    writeXlsx('P28-activity-named-like-a-day-sched.xlsx', [['Grid', rows]])
  } })

add({ id: 'P29', file: 'P29-compound-period-headers.csv', entry: 'pref', class: 'E',
  shape: 'Class E compound headers, one row per camper: "Monday Period 3 - First Choice", ...',
  expect: 'no #N header, so no ranks found',
  write: () => {
    const head = ['Camper Name']
    const cols = []
    for (const d of ['Monday', 'Wednesday', 'Friday']) for (const c of ['First Choice', 'Second Choice']) cols.push(`${d} Period 3 - ${c}`)
    head.push(...cols)
    const rows = [head]
    for (let i = 0; i < 8; i += 1) rows.push([name(i), ...cols.map((_, k) => act(i * 2 + k))])
    writeCsv('P29-compound-period-headers.csv', rows)
  } })

add({ id: 'P30', file: 'P30-per-cell-hash-headers.csv', entry: 'pref', class: 'E',
  shape: 'Per-cell sheet whose headers ARE hash-ranks but repeat per period: "Monday #1", "Monday #2", "Wednesday #1"',
  expect: 'anchored regex misses them entirely',
  write: () => {
    const head = ['Camper Name']
    const cols = []
    for (const d of ['Monday', 'Wednesday']) for (const r of [1, 2]) cols.push(`${d} #${r}`)
    head.push(...cols)
    const rows = [head]
    for (let i = 0; i < 8; i += 1) rows.push([name(i), ...cols.map((_, k) => act(i * 2 + k))])
    writeCsv('P30-per-cell-hash-headers.csv', rows)
  } })

// ---- Shapes NOT previously discussed in the ADR. The point of agnosticism is
// the shape nobody anticipated; if every probe is one we already named, the
// corpus only proves we can read our own list.
add({ id: 'P31', file: 'P31-tidy-long-format.csv', entry: 'pref', class: 'NEW',
  shape: 'INVENTED: tidy/long export — one row per (camper, rank, activity), which is what a normalised form backend emits',
  expect: 'no #N columns; the sheet is entirely legible to a human and illegible here',
  write: () => {
    const rows = [['Camper Name', 'Choice Rank', 'Activity Name']]
    for (let i = 0; i < 8; i += 1) for (let r = 1; r <= 3; r += 1) rows.push([name(i), String(r), act(i * 3 + r)])
    writeCsv('P31-tidy-long-format.csv', rows)
  } })

add({ id: 'P32', file: 'P32-activities-as-columns.csv', entry: 'pref', class: 'NEW',
  shape: 'INVENTED: inverted matrix — one column per ACTIVITY, the cell holds the rank number',
  expect: 'no #N columns; ranks live in cells, not headers',
  write: () => {
    const acts = ACT.slice(0, 8)
    const rows = [['Camper Name', 'Division', ...acts]]
    for (let i = 0; i < 8; i += 1) {
      rows.push([name(i), 'Upper Division', ...acts.map((_, k) => (k === i % 8 ? '1' : k === (i + 1) % 8 ? '2' : k === (i + 2) % 8 ? '3' : ''))])
    }
    writeCsv('P32-activities-as-columns.csv', rows)
  } })

add({ id: 'P33', file: 'P33-per-cell-long-format.csv', entry: 'pref', class: 'NEW',
  shape: 'INVENTED: per-cell preferences in LONG form — the same camper repeated once per (day, period) block, each block carrying its own legitimate #1..#3',
  expect: 'rows collapse onto one derived camper id, so legitimate per-cell rank 1s look like a same-name collision',
  write: () => {
    const rows = [['Camper Name', 'Day Of Week', 'Period Number', '#1', '#2', '#3']]
    for (let i = 0; i < 5; i += 1) {
      for (const d of ['Monday', 'Wednesday', 'Friday']) {
        for (const p of ['3', '6']) rows.push([name(i), d, p, act(i + 1), act(i + 2), act(i + 3)])
      }
    }
    writeCsv('P33-per-cell-long-format.csv', rows)
  } })

add({ id: 'P34', file: 'P34-split-name-columns.csv', entry: 'pref', class: 'NEW',
  shape: 'INVENTED: name split across "First Name" and "Last Name", which is what most form tools emit by default',
  expect: 'neither column matches NAME_HEADER',
  write: () => {
    const rows = [['First Name', 'Last Name', 'Division', '#1', '#2', '#3']]
    for (let i = 0; i < 8; i += 1) {
      const [f, l] = name(i).split(' ')
      rows.push([f, l, 'Upper Division', act(i), act(i + 1), act(i + 2)])
    }
    writeCsv('P34-split-name-columns.csv', rows)
  } })

add({ id: 'P35', file: 'P35-group-column-is-a-track.csv', entry: 'pref', class: 'NEW',
  shape: 'INVENTED: a column headed "Group" that holds an ACTIVITY TRACK, not a division — DIVISION_HEADER matches /group/',
  expect: 'the track is written into campers.division',
  write: () => {
    const rows = [['Camper Name', 'Group', '#1', '#2', '#3']]
    for (let i = 0; i < 8; i += 1) rows.push([name(i), ['Sports Track', 'Arts Track', 'Outdoor Track'][i % 3], act(i), act(i + 1), act(i + 2)])
    writeCsv('P35-group-column-is-a-track.csv', rows)
  } })

add({ id: 'P36', file: 'P36-name-column-is-the-counselor.csv', entry: 'pref', class: 'NEW',
  shape: 'INVENTED: two person columns — "Counselor Name" and a camper column headed just "Camper". Only one of them matches anything.',
  expect: 'preferences attributed to whichever column the pattern happens to hit',
  write: () => {
    const rows = [['Child Name', 'Counselor Name', '#1', '#2', '#3']]
    for (let i = 0; i < 8; i += 1) rows.push([name(i), name(i + 16), act(i), act(i + 1), act(i + 2)])
    writeCsv('P36-name-column-is-the-counselor.csv', rows)
  } })

add({ id: 'P37', file: 'P37-kind3-reimport-same-bytes.csv', entry: 'pref', class: 'B',
  shape: 'RE-IMPORT: byte-identical to P01, imported twice in a row (ADR 8 idempotency row)',
  expect: 'derived run id converges; second import is a no-op, not a doubling',
  reimport: 'same',
  write: () => writeCsv('P37-kind3-reimport-same-bytes.csv', kind3(12, 3)) })

add({ id: 'P38', file: 'P38-kind3-reimport-drifted.csv', entry: 'pref', class: 'B',
  shape: 'DRIFTED RE-IMPORT: P37 with one rank column renamed and one extra camper (ADR 8 drift row)',
  expect: 'a drifted file must not silently inherit the prior reading',
  reimport: 'drift-of-P37',
  write: () => {
    const rows = kind3(13, 3)
    rows[0][4] = 'Third Choice'
    writeCsv('P38-kind3-reimport-drifted.csv', rows)
  } })

add({ id: 'P39', file: 'P39-empty-under-header.csv', entry: 'pref', class: 'B',
  shape: 'DEGENERATE: a valid header row with no data rows at all',
  expect: 'refused for having no rows under its header',
  write: () => writeCsv('P39-empty-under-header.csv', [kind3(0, 3)[0]]) })

add({ id: 'P40', file: 'P40-text-grid-daysheet.txt', entry: 'sched', class: 'A',
  shape: 'The planner grid as a plain-text grid, the format parseTextGrid takes',
  expect: 'the text path is a different reader from the workbook path',
  write: () => {
    const rows = plannerGrid()
    writeTxt('P40-text-grid-daysheet.txt', rows.map((r) => r.join('\t')).join('\n') + '\n')
  } })

// ---- T251: the T199 spec section 6 ACCEPTANCE CAMP's preference sheet.
//
// docs/work/tickets/T251-t199-acceptance-fixture.md;
// docs/work/specs/2026-09-17-individual-elective-scheduling-implementation.md section 6.
//
// WHY IT IS DECLARED HERE rather than in a second generator. Every camper name
// in this repository's fixtures has to come from synthetic-names.json and be
// reachable by the name scan (test/preferenceCorpusNames.test.js). A second
// hand-written .csv committed under test/fixtures/ would be outside both, which
// is exactly the hole that scan exists to close. So the acceptance sheet is
// declared as a probe like every other, and the scan was widened to the
// directory it writes to.
//
// IT WRITES OUTSIDE probes/ deliberately: it is not a shape probe (it exercises
// no reader shape the corpus does not already cover) and must not be swept up by
// scripts/preferenceCorpusProbe.mjs's shape report. `outDir` is the one
// mechanism for that, used by nothing else.
//
// TWO FILES, and the pair IS the acceptance condition. Spec section 6's first pass
// condition is "ambiguous rows block until resolved": the blocking file carries
// two rows for one name in one division with no camper id, and the resolved file
// is the SAME bytes with an id added to each. Nothing else differs, so a commit
// that succeeds on the second proves the first was refused for the collision and
// not for anything else.
const ACCEPTANCE_DIR = 'test/fixtures/elective-acceptance'

// The camp the grid at test/fixtures/elective-acceptance/camp-grid.txt defines:
// tiers Younger/Older, one elective cell per day at the 10:50-11:30 block.
const AC_PERIOD = '10:50-11:30'
const AC_YOUNGER = 'Younger'
const AC_OLDER = 'Older'

// name, external id, division. `null` id is the spec's "one missing external id"
// AND the blocking collision's cause -- one fact, not two contrived ones.
const AC_ROSTER = [
  ['Noa Quartzite', 'SYN-1001', AC_YOUNGER], ['Eli Basalt', 'SYN-1002', AC_YOUNGER],
  ['Tamar Gneiss', 'SYN-1003', AC_YOUNGER], ['Yonah Slatestone', 'SYN-1004', AC_YOUNGER],
  ['Maya Obsidian', 'SYN-1005', AC_YOUNGER], ['Dov Limeshale', 'SYN-1006', AC_YOUNGER],
  ['Shira Pyrite', 'SYN-1007', AC_YOUNGER], ['Gil Marlstone', 'SYN-1008', AC_YOUNGER],
  ['Adin Chertwood', 'SYN-1009', AC_YOUNGER], ['Liora Jasperly', 'SYN-1010', AC_YOUNGER],
  // The legal duplicate: one name, two DIFFERENT divisions, both carrying an id.
  ['Ari Feldspar', 'SYN-1011', AC_YOUNGER],
  ['Amit Granitine', 'SYN-2001', AC_OLDER], ['Tzvi Micafold', 'SYN-2002', AC_OLDER],
  ['Ilana Serpentine', 'SYN-2003', AC_OLDER], ['Oren Halitebrook', 'SYN-2004', AC_OLDER],
  ['Bracha Gypsumfield', 'SYN-2005', AC_OLDER], ['Yael Andesite', 'SYN-2006', AC_OLDER],
  ['Kobi Rhyolite', 'SYN-2007', AC_OLDER], ['Dalia Travertine', 'SYN-2008', AC_OLDER],
  ['Ari Feldspar', 'SYN-2011', AC_OLDER],
  // The blocking duplicate: one name, the SAME division, no id on either row.
  ['Rivka Sandarch', null, AC_OLDER], ['Rivka Sandarch', null, AC_OLDER],
]

// Campers who answer for the WHOLE RUN instead of per cell -- one row, no
// coordinate. The legal shape commitElectiveRun.js:70-92 requires be accepted.
const AC_WHOLE_RUN = [
  ['Nadav Calcite', 'SYN-1012', AC_YOUNGER], ['Ronit Dolomite', 'SYN-1013', AC_YOUNGER],
  ['Netanel Siltstone', 'SYN-2009', AC_OLDER],
  // Spec section 6's "one missing external id". A UNIQUE name, so it is an
  // absent id and nothing else -- putting it on one of the same-named rows
  // instead would conflate it with the collision case, which is a different
  // fact the sheet already carries twice over.
  ['Zohar Peridot', null, AC_OLDER],
]

// The ranked answers, by (division, day, camper index within that division's
// coordinate-answering campers). Written out rather than computed so the
// contention is READABLE: at Monday/Younger nine of eleven campers rank Ropes
// (three seats) first, which is spec section 6's "one capacity shortfall".
function acRanks(division, day, i) {
  if (division === AC_YOUNGER) {
    if (day === 'Monday') {
      if (i < 9) return ['Ropes', 'Swim', 'Archery']
      if (i === 9) return ['Swim', 'Archery', 'Ceramics']
      return ['Archery', 'Ceramics', 'Garden']
    }
    if (day === 'Tuesday') {
      return i < 5 ? ['Ceramics', 'Woodshop', 'Garden'] : ['Woodshop', 'Garden', 'Swim']
    }
    return ['Garden', 'Swim', 'Ceramics']
  }
  if (day === 'Monday') {
    // The first four Older campers rank the BUNDLE. It is named 'Ropes', after
    // its own activity, and that is FORCED rather than chosen: ADR
    // 2026-09-29-linked-elective-bundles.md D4 says the bundle's name is the
    // string a camper's sheet must match, but buildPreferenceCatalog
    // (src/ingest/preferenceImport.js:91-97) is built from activities, groups
    // and tiers and never from bundles -- so a bundle named anything else is
    // UNRESOLVED_CHOICE_LABEL residue and the preference is dropped before it
    // reaches the solver. preferences-bundle-by-name.csv, below, is the fixture
    // that holds that gap open.
    if (i < 4) return ['Ropes', 'Swim', 'Ceramics']
    if (i < 8) return ['Swim', 'Ceramics', 'Garden']
    if (i === 8) return ['Ceramics', 'Garden', 'Woodshop']
    return ['Garden', 'Swim', 'Ceramics']
  }
  if (day === 'Tuesday') {
    if (i < 4) return ['Ropes', 'Woodshop', 'Garden']
    if (i < 8) return ['Woodshop', 'Garden', 'Swim']
    if (i === 8) return ['Garden', 'Woodshop', 'Swim']
    return ['Woodshop', 'Garden', 'Swim']
  }
  return ['Swim', 'Ceramics', 'Garden']
}

// Which (division, day) cells each camper answers for. Older campers 4, 5 and 6
// answer for WEDNESDAY, where the Generated route places this set on the Younger
// tier only -- spec section 6's "one eligibility rejection", and the reason the
// asymmetry between the two routes is in the fixture at all.
function acDaysFor(division, i) {
  if (division === AC_YOUNGER) return ['Monday', 'Tuesday', 'Wednesday']
  return i >= 4 && i <= 6 ? ['Monday', 'Tuesday', 'Wednesday'] : ['Monday', 'Tuesday']
}

function acceptanceRows({ resolved }) {
  const head = ['Camper ID', 'Camper Name', 'Division', 'Day', 'Period', '#1', '#2', '#3']
  const rows = [head]
  // Resolving the collision is ONE edit a director makes in their own sheet: the
  // two same-named rows get told apart by a camper id. Nothing else changes.
  const resolvedIds = { 0: 'SYN-2012', 1: 'SYN-2013' }
  let unidentified = 0
  const perDivision = { [AC_YOUNGER]: 0, [AC_OLDER]: 0 }
  for (const [name, id, division] of AC_ROSTER) {
    const i = perDivision[division]
    perDivision[division] += 1
    let externalId = id ?? ''
    if (id == null) {
      if (resolved) externalId = resolvedIds[unidentified] ?? ''
      unidentified += 1
    }
    for (const day of acDaysFor(division, i)) {
      rows.push([externalId, name, division, day, AC_PERIOD, ...acRanks(division, day, i)])
    }
  }
  for (const [name, id, division] of AC_WHOLE_RUN) {
    rows.push([id ?? '', name, division, '', '', 'Swim', 'Ceramics', 'Garden'])
  }
  return rows
}

// DELIBERATELY NOT `add()`. Every entry `add()` records becomes a manifest row,
// and scripts/preferenceCorpusProbe.mjs reads every manifest row out of probes/
// -- these two do not live there, so registering them would break the shape
// report with a file-not-found. They are emitted below, beside the probes.
const acceptanceFixtures = [
  { file: 'preferences.csv', write: () => writeCsvTo(ACCEPTANCE_DIR, 'preferences.csv', acceptanceRows({ resolved: false })) },
  { file: 'preferences-resolved.csv', write: () => writeCsvTo(ACCEPTANCE_DIR, 'preferences-resolved.csv', acceptanceRows({ resolved: true })) },
  // THE GAP FIXTURE. Byte-for-byte the resolved sheet, except that the four
  // campers who want the bundle write its DIRECTOR-GIVEN name instead of the
  // activity's. ADR D4 says that is the supported way to say it; the parser
  // drops it. Held open by electron/electiveAcceptanceImport.integration.test.js
  // so the day someone puts bundle names in the catalog, the assertion that the
  // label is unresolved goes red.
  { file: 'preferences-bundle-by-name.csv',
    write: () => writeCsvTo(ACCEPTANCE_DIR, 'preferences-bundle-by-name.csv',
      acceptanceRows({ resolved: true }).map((r, i) => (i === 0 ? r : r.map((c) => (c === 'Ropes' ? 'Ropes Intensive' : c))))) },
]

// --- emit ----------------------------------------------------------------
fs.rmSync(PROBES, { recursive: true, force: true })
fs.mkdirSync(PROBES, { recursive: true })
for (const p of probes) p.write()
// T251 — outside probes/, so outside the rmSync above and outside the manifest.
for (const f of acceptanceFixtures) f.write()

const manifest = {
  _provenance: 'GENERATED by scripts/fixtures/make-preference-corpus.mjs. Synthetic identities only (ADR 8.0).',
  generated_probes: probes.length,
  shape_classes_covered: [...new Set(probes.map((p) => p.class))].sort(),
  note_class_H: 'ABSENT BY DESIGN — a camp-platform portal export has no published spec and no sample. Never fabricated. ADR 9 Q1 is closed NO.',
  probes: probes.map(({ id, file, entry, class: cls, shape, expect, reimport }) => ({
    id, file, entry, class: cls, shape, hypothesis: expect, reimport: reimport ?? null,
  })),
}
fs.writeFileSync(path.join(DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
process.stdout.write(`wrote ${probes.length} probes to ${path.relative(ROOT, PROBES)}\n`)
