// Director-guide screenshots from the PACKAGED app. DIRECTOR_GUIDE.md marks each screenshot with
// <!-- shot: name -->; this captures every marked shot at 1280x800 into docs/guide/img/<name>.png.
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
const STEPS = '1,2,3,4,5,6,9,12'

const names = [...fs.readFileSync(GUIDE, 'utf8').matchAll(/<!--\s*shot:\s*([\w./-]+)\s*-->/g)].map((m) => m[1])
if (!names.length) { console.error(`no <!-- shot: name --> markers in ${path.relative(REPO, GUIDE)}`); process.exit(2) }
console.log(`${names.length} marked shots: ${names.join(', ')}`)

const started = Date.now()
const forwarded = process.argv.slice(2).filter((a) => !a.startsWith('--only='))
const run = spawnSync(process.execPath, [path.join(HERE, 'driver.mjs'), '--guide', `--only=${STEPS}`, `--repo=${REPO}`, ...forwarded], { stdio: 'inherit', cwd: REPO })

const fresh = (n) => { try { return fs.statSync(path.join(IMG, `${n}.png`)).mtimeMs >= started } catch { return false } }
const missing = names.filter((n) => !fresh(n))
for (const n of names) console.log(`${fresh(n) ? 'OK     ' : 'MISSING'} docs/guide/img/${n}.png`)
if (run.status !== 0) console.error(`driver exited ${run.status}: a step failed, so its shots may be missing or show the wrong state`)
if (missing.length) { console.error(`${missing.length} of ${names.length} marked shots were not captured: ${missing.join(', ')}`); process.exit(1) }
process.exit(run.status === 0 ? 0 : 1)
