// Director-guide screenshots from the PACKAGED app. Every shot DIRECTOR_GUIDE.md asks for (a placeholder,
// <!-- shot: name --> or [shot: name], or an image it already links) is captured at 1280x800 into
// docs/guide/img/<name>.png, and each placeholder is replaced by its image link with the alt text in ALT.
// It fails if any shot is not freshly captured or any placeholder is left in the guide.
//
//   node scripts/finalAudit/guideShots.mjs --app=release/mac/Shoresh.app/Contents/MacOS/Shoresh [--port=9900]
//
// It reuses the final-audit flows rather than re-driving the app: the driver runs in --guide mode, and the
// steps that reach each marked screen take the shot there (steps.mjs, `guide(...)`). Only those steps run.
// It fails, naming them, if any marker in the guide has no fresh image afterwards: a marker with no hook in
// the steps, or a step that did not reach its screen. Run it on a fresh userData (the driver makes one).
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../..')
const GUIDE = path.join(REPO, 'docs/guide/DIRECTOR_GUIDE.md')
const IMG = path.join(REPO, 'docs/guide/img')
// The audit steps that hold a guide shot: 1 (one-day file card), 4 (bring recurring events), 5 (keep or
// replace, undo receipt), 6 (what Shoresh has learned), 9 (locations), 12 (turn off encryption). Steps 2 and
// 3 hold no shot but build the schedules, so the Replace choice shows "saved as a version first" as the
// guide describes (and step 5's "Before replace" check has a schedule to save).
const STEPS = '1,2,3,4,5,6,9,18,12'

// Alt text for each shot: what the picture shows, in the guide's words.
const ALT = {
  'import/keep-or-replace': 'Import screen with 71 items already set up and the Keep them and Replace them choices, Replace saying the schedules are saved as a version first',
  'import/one-day-file-card': 'This looks like a single-day schedule card for Color War Day, with the new activities it adds and the week and day dropdowns',
  'reconcile/undo-receipt': 'Undo complete, removed 22 records the import created, with a Continue button',
  'learned/what-shoresh-has-learned': 'What Shoresh has learned, with one Classification answer and its Change and Forget answer links',
  'special-day/bring-recurring-events': 'A special day placed on Week 1 Friday, offering to also bring 5 recurring events from Friday with Bring and Skip',
  'devices/turn-off-encryption': 'Encryption on this computer, with DISABLE ENCRYPTION typed in the confirmation box and the Turn off encryption button',
  'worksheet/locations-sheet': 'Locations screen with one location and the Download Template and Import from Excel links at the bottom',
  'import/drop-zone': 'Import last year, with the Drop schedule here area, the Choose a file button and Download worksheet',
  'import/preview': 'The import preview: what Shoresh found in the file, before Replace with records',
  'reconcile/questions': 'The import questions, under Needs your attention, with how many are answered',
  'generated/first-week': 'Generated Schedule after Generate a schedule, the week filled in with the Placed, Unfillable and Still needed counts',
  'generated/unfillable-hover': 'Unfillable cells on the Generated Schedule, with Still to place listing each one and its reason, such as Weekly max reached',
  'manual-build/dragging': 'Manual Build while dragging an activity from the Activities panel onto an Open cell',
  'manual-build/overlap-dot': 'Manual Build with a small dot on cells where too many groups share one activity',
  'elective-set/offerings': 'An elective set opened, with its offerings, Capacity and Minimum, and Add Offering',
  'schedule/elective-sets-in-rail': 'The Activities panel on Manual Build, with the Elective sets section',
  'schedule/cell-editor-elective-sets': 'A schedule cell being edited, its suggestions listing the Elective sets',
  'generated/replaced-day': 'The Generated Schedule with Friday replaced by the special day, shown as its own lane',
  'sidebar/restore-confirmation': 'Restore from backup confirmation, naming the backup date and saying it replaces this camp\'s data',
  'sidebar/cant-reach-the-camp-flag': 'The sidebar row on a laptop that has to pair again, leading to the Pair again screen',
  'pair-again/code-screen': 'The Pair again screen, asking for the camp code',
  'devices/router-flag': 'Devices, with the router line under the title: Devices on this Wi-Fi connect normally',
  'electives/camper-import-preview': 'A camper preference sheet being read: its columns matched to Camper name, Camper ID, Division and each Rank',
  'rainy-day': 'Rainy day… open on the schedule toolbar with the week\'s days to pick from, and the note after a rainy day saying how many switched to rain plans, with Undo',
}

// Every shot the guide asks for: placeholders (<!-- shot: x --> or [shot: x]) and images it already links.
const PLACEHOLDER = /<!--\s*shot:\s*([\w./-]+)\s*-->|\[shot:\s*([\w./-]+)\s*\]/g
const LINKED = /\]\(img\/([\w./-]+)\.png\)/g
const text0 = fs.readFileSync(GUIDE, 'utf8')
const names = [...new Set([...[...text0.matchAll(PLACEHOLDER)].map((m) => m[1] || m[2]), ...[...text0.matchAll(LINKED)].map((m) => m[1])])]
if (!names.length) { console.error(`no shots in ${path.relative(REPO, GUIDE)}`); process.exit(2) }
const noAlt = names.filter((n) => !ALT[n])
if (noAlt.length) { console.error(`no alt text in guideShots.mjs ALT for: ${noAlt.join(', ')}`); process.exit(2) }
console.log(`${names.length} shots: ${names.join(', ')}`)

const started = Date.now()
const forwarded = process.argv.slice(2).filter((a) => !a.startsWith('--only='))
const run = spawnSync(process.execPath, [path.join(HERE, 'driver.mjs'), '--guide', `--only=${STEPS}`, `--repo=${REPO}`, ...forwarded], { stdio: 'inherit', cwd: REPO })

const fresh = (n) => { try { return fs.statSync(path.join(IMG, `${n}.png`)).mtimeMs >= started } catch { return false } }
const missing = names.filter((n) => !fresh(n))
for (const n of names) console.log(`${fresh(n) ? 'OK     ' : 'MISSING'} docs/guide/img/${n}.png`)
if (run.status !== 0) console.error(`driver exited ${run.status}: a step failed, so its shots may be missing or show the wrong state`)

// Link every captured placeholder; a placeholder whose shot is missing stays, and fails below.
const text1 = text0.replace(PLACEHOLDER, (all, a, b) => { const n = a || b; return fresh(n) ? `![${ALT[n]}](img/${n}.png)` : all })
if (text1 !== text0) fs.writeFileSync(GUIDE, text1)
const left = [...text1.matchAll(PLACEHOLDER)].map((m) => m[0])
if (left.length) console.error(`${left.length} placeholder(s) still in the guide: ${left.join(', ')}`)
if (missing.length) console.error(`${missing.length} of ${names.length} shots were not captured: ${missing.join(', ')}`)
process.exit(run.status === 0 && !missing.length && !left.length ? 0 : 1)
