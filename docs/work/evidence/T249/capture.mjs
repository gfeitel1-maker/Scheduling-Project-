import { chromium } from 'playwright'
import fs from 'node:fs'

// Relative to this file, so no personal absolute path enters git history (T120).
const OUT = import.meta.dirname
fs.mkdirSync(OUT, { recursive: true })
const URL = process.env.SHOT_URL || 'http://localhost:5211/'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1000, height: 760 }, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

await page.goto(URL)
await page.waitForFunction(() => typeof window.__seedDemo === 'function')
await page.evaluate(() => window.__seedDemo())
await page.waitForTimeout(1200)

// Fabricated fixture only: place the (fabricated) elective set on a schedule slot so the
// panel reaches its real "No run" entry state rather than the "not on a schedule" branch.
await page.getByText('Electives', { exact: true }).click()
await page.waitForTimeout(600)
await page.getByPlaceholder('e.g. Afternoon Chugim').fill('Afternoon Chugim')
await page.getByRole('button', { name: /Add$/ }).click()
await page.waitForTimeout(600)
const setId = await page.evaluate(() => JSON.parse(localStorage.getItem('shoresh-mock-state')).elective_sets[0].id)
await page.evaluate((id) => {
  const s = JSON.parse(localStorage.getItem('shoresh-mock-state'))
  s.template_slots[0].elective_set_id = id
  localStorage.setItem('shoresh-mock-state', JSON.stringify(s))
}, setId)
await page.reload()
await page.waitForTimeout(1500)
await page.getByText('Electives', { exact: true }).click()
await page.waitForTimeout(700)
await page.getByRole('button', { name: 'Open', exact: true }).first().click()
await page.waitForTimeout(1200)

const row = page.getByRole('note')
await row.waitFor()
const text = await row.innerText()
console.log('DISCLOSURE TEXT:', JSON.stringify(text))
console.log('CONTROLS INSIDE THE ROW:', await row.locator('button, a, input, [role="button"]').count())

await page.screenshot({ path: `${OUT}/01-entry-no-run-state.png` })
await row.screenshot({ path: `${OUT}/02-disclosure-row-closeup.png` })

// ...and it is still there after the director moves into the import flow.
await page.getByRole('button', { name: /Import Camper Preferences/i }).click()
// NOTE: there are TWO file inputs on this screen with IDENTICAL accept attrs.
// The first belongs to the offerings importer; AssignmentPanel's is the last.
// Targeting the first produced a screenshot that looked like evidence and was
// not -- it showed the offerings importer's error, with the panel still in its
// entry state.
await page.locator('input[type=file]').last().setInputFiles({
  name: 'fabricated-preferences.txt',
  mimeType: 'text/plain',
  buffer: Buffer.from('Name\t#1\t#2\nFixture Camper One\tSwim\tArt\nFixture Camper Two\tArt\tSwim\n'),
})
await page.getByText('Confirm Mapping').waitFor()
console.log('PHASE REACHED:', (await page.locator('main').innerText()).includes('Confirm Mapping') ? 'mapping' : 'NOT mapping')
await page.screenshot({ path: `${OUT}/03-still-present-in-mapping-phase.png` })
console.log('MAPPING PHASE, DISCLOSURE STILL PRESENT:', await page.getByRole('note').count())
console.log('MAPPING PHASE DISCLOSURE TEXT:', JSON.stringify(await page.getByRole('note').innerText()))

console.log('PAGE ERRORS:', errors.length ? errors : 'none')
await browser.close()
