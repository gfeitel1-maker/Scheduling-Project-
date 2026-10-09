// Usage: node capture.mjs <before|after>   (dev server at SHOT_URL, default :5231)
// Playwright is resolved from wherever it is installed; this repo does not depend on it.
import fs from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(process.env.PLAYWRIGHT_FROM || import.meta.url)
const { chromium } = require('playwright')

const OUT = import.meta.dirname
const LABEL = process.argv[2]
const URL = process.env.SHOT_URL || 'http://localhost:5231/'
const SAMPLE = new globalThis.URL('../../specs/samples/campB-by-day.txt', import.meta.url).pathname

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 860 } })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

// The browser mock has no import_evidence table (src/localClient.mock.js says
// so: the provenance dot never renders in browser-dev). Capture-only fixture:
// rewrite the mock's listImportEvidence so the first three activities carry
// (1) an inferred + an observed field, (2) observed only, (3) inferred only.
// Nothing here is committed to app code.
await page.route(/localClient\.mock\.js/, async (route) => {
  const res = await route.fetch()
  let body = await res.text()
  body = body.replace(
    /async listImportEvidence\(\) \{\s*return \{\s*evidence: \[\],\s*fieldSources: \{\}\s*\}/,
    `async listImportEvidence() {
    const acts = (loadState().activities || []).filter((a) => !a.deleted_at).sort((x, y) => x.name.localeCompare(y.name))
    const ev = (a, field, tag, i) => ({ id: 'cap-' + a.id + field, entity_type: 'activities', entity_id: a.id, field, tag, confidence: tag === 'observed' ? 'high' : 'low', support: {}, import_run_id: 'cap', committed_at: '2026-10-09T00:00:00Z' })
    const evidence = []; const fieldSources = {}
    const all = { min_per_week: 'import', max_per_week: 'import', eligible_group_ids: 'import', location_id: 'import', max_groups_per_slot: 'import' }
    if (acts[0]) { evidence.push(ev(acts[0], 'min_per_week', 'inferred'), ev(acts[0], 'location', 'observed'), ev(acts[0], 'eligible_group_names', 'observed'), ev(acts[0], 'max_groups_per_slot', 'observed')); fieldSources[acts[0].id] = all }
    if (acts[1]) { evidence.push(ev(acts[1], 'min_per_week', 'observed'), ev(acts[1], 'location', 'observed'), ev(acts[1], 'eligible_group_names', 'observed'), ev(acts[1], 'max_groups_per_slot', 'observed')); fieldSources[acts[1].id] = all }
    if (acts[2]) { evidence.push(ev(acts[2], 'min_per_week', 'observed')); fieldSources[acts[2].id] = { min_per_week: 'import', max_per_week: 'import' } }
    return { evidence, fieldSources }`,
  )
  if (!body.includes("'cap-'")) throw new Error('mock rewrite did not apply')
  await route.fulfill({ response: res, body })
})

await page.goto(URL)
await page.waitForFunction(() => typeof window.__seedDemo === 'function')
await page.evaluate(() => window.__seedDemo())
await page.waitForTimeout(1500)

// Reconciliation step after loading the by-day sample.
await page.getByText('Import last year').click()
await page.locator('input[type=file]').first().setInputFiles(SAMPLE)
await page.getByRole('button', { name: /^Review \d+ records/ }).click()
await page.getByText(/^Reconciling /).waitFor()
await page.waitForTimeout(800)
await page.screenshot({ path: `${OUT}/${LABEL}-1-reconciliation.png` })

// Activities: where the provenance dot actually renders.
await page.getByRole('button', { name: /Activities$/ }).first().click()
await page.waitForTimeout(1500)
await page.screenshot({ path: `${OUT}/${LABEL}-2-activities-dots.png` })
const dots = await page.getByRole('button', { name: /^Provenance:/ }).count()
console.log(LABEL, 'provenance dots on Activities:', dots)
if (dots) {
  await page.getByRole('button', { name: /^Provenance:/ }).first().click()
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT}/${LABEL}-3-activities-popover.png` })
  await page.keyboard.press('Escape')
}

// Stat boxes on the generated schedule.
await page.getByRole('button', { name: 'Generated Schedule' }).click()
await page.waitForTimeout(1500)
const gen = page.getByRole('button', { name: /^Generate/ }).first()
if (await gen.count()) { await gen.click(); await page.waitForTimeout(3000) }
await page.getByText('Placed', { exact: true }).waitFor()
await page.screenshot({ path: `${OUT}/${LABEL}-4-schedule-stat-boxes.png` })
console.log(LABEL, 'Placed value colour:', await page.getByText('Placed', { exact: true }).evaluate((el) => el.previousElementSibling.style.color))

console.log('PAGE ERRORS:', errors.length ? errors : 'none')
fs.writeFileSync(`${OUT}/${LABEL}-log.txt`, `dots=${dots}\nerrors=${errors.length}\n`)
await browser.close()
