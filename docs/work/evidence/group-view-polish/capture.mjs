// Before/after evidence for the group-view polish PR. Run against `npm run dev`
// (mock client): PHASE=before|after SHOT_URL=http://localhost:5200/ node capture.mjs
// PLAYWRIGHT may point at a playwright install if it is not resolvable here.
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright')
const OUT = import.meta.dirname
const PHASE = process.env.PHASE || 'after'
const URL = process.env.SHOT_URL || 'http://localhost:5200/'

const browser = await chromium.launch()

async function open(route, vh = 860) {
  const p = await browser.newPage({ viewport: { width: 1400, height: vh } })
  await p.goto(URL)
  await p.waitForFunction(() => typeof window.__seedDemo === 'function')
  await p.evaluate(() => window.__seedDemo())
  await p.waitForTimeout(1500)
  await p.getByText(route, { exact: true }).first().click()
  await p.waitForTimeout(800)
  await p.getByRole('button', { name: 'Group View' }).click()
  await p.waitForTimeout(800)
  const blank = p.getByRole('button', { name: 'Start a blank week' })
  if (await blank.count()) { await blank.click(); await p.waitForTimeout(1200) }
  return p
}
const center = (p, k) => p.$eval(`[data-cell-key="${k}"]`, e => {
  const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: e.textContent.trim() }
})

// 1. Collapsed row (Second Period folded).
{
  const p = await open('Generated Schedule')
  await p.screenshot({ path: `${OUT}/${PHASE}-01-group-view.png` })
  await p.getByRole('button', { name: /Second Period/ }).click()
  await p.waitForTimeout(400)
  await p.screenshot({ path: `${OUT}/${PHASE}-02-collapsed-row.png` })
  const header = p.getByRole('button', { name: /Second Period/ })
  console.log(PHASE, 'collapsed aria-expanded =', await header.getAttribute('aria-expanded'),
    '| chevron present =', await header.locator('.row-header-chevron').count() > 0)
  await p.close()
}

// 2. Keyboard pick-up: focus Mon/Third, Space, ArrowRight.
{
  const p = await open('Generated Schedule')
  // Enter the grid at its one tab stop, then arrow to Mon/Third (row 4, col 2).
  await p.locator('[role="grid"] [tabindex="0"]').first().focus()
  for (const k of ['ArrowDown', 'ArrowDown', 'ArrowDown', 'ArrowRight']) await p.keyboard.press(k)
  console.log(PHASE, 'focused', await p.evaluate(() => document.activeElement.getAttribute('data-cell-key')))
  await p.keyboard.press('Space'); await p.waitForTimeout(250)
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(250)
  const state = await p.evaluate(() => ({
    source: [...document.querySelectorAll('[data-drag-source]')].map(e => e.getAttribute('data-cell-key')),
    over: [...document.querySelectorAll('[data-drag-over]')].map(e => e.getAttribute('data-cell-key')),
  }))
  console.log(PHASE, 'keyboard pick-up + ArrowRight:', JSON.stringify(state))
  await p.screenshot({ path: `${OUT}/${PHASE}-03-keyboard-pickup.png` })
  await p.keyboard.press('Escape')
  await p.close()
}

// 3. Pointer drag to First Period/Monday on both routes, with the page scrolled
// mid-drag (the condition that produced the Tester's mis-drop).
for (const route of ['Generated Schedule', 'Manual Build']) {
  const p = await open(route, 560)
  await p.evaluate(() => { document.querySelector('main').scrollTop = 160 })
  await p.waitForTimeout(300)
  const target = 'grp-1|day-0|blk-0'
  const from = route === 'Manual Build'
    ? await p.$eval('[data-palette-activity]', e => { const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: e.textContent } })
    : await center(p, 'grp-1|day-2|blk-4')
  await p.mouse.move(from.x, from.y); await p.mouse.down()
  await p.mouse.move(from.x + 20, from.y - 20, { steps: 5 })
  await p.mouse.wheel(0, -160); await p.waitForTimeout(300)
  const t = await center(p, target)
  await p.mouse.move(t.x, t.y, { steps: 15 }); await p.waitForTimeout(200)
  await p.mouse.up(); await p.waitForTimeout(900)
  const landed = (await center(p, target)).text
  console.log(PHASE, route, 'drop on First Period/Monday ->', JSON.stringify(landed), '(dragged', JSON.stringify(from.text.slice(0, 8)) + ')')
  await p.screenshot({ path: `${OUT}/${PHASE}-04-drop-${route.startsWith('M') ? 'manual' : 'generated'}.png` })
  await p.close()
}

await browser.close()
