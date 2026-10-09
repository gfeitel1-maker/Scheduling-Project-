// Before/after evidence for Design F6 (admin list widths). Run against
// `npm run dev`: PHASE=before|after SHOT_URL=http://localhost:5200/ node capture.mjs
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright')
const OUT = import.meta.dirname
const PHASE = process.env.PHASE || 'after'
const URL = process.env.SHOT_URL || 'http://localhost:5200/'

const browser = await chromium.launch()
const p = await browser.newPage({ viewport: { width: 1400, height: 860 } })
await p.goto(URL)
await p.waitForFunction(() => typeof window.__seedDemo === 'function')
await p.evaluate(() => window.__seedDemo())
await p.waitForTimeout(1500)

for (const [i, item] of ['Conflicts', 'Trash', /Devices/].entries()) {
  await p.getByRole('button', { name: 'Settings' }).click()
  await p.getByRole('menuitem', { name: item }).click()
  await p.waitForTimeout(800)
  const width = await p.$eval('main', m => {
    const page = m.querySelector('[style*="max-width"]')
    return page ? Math.round(page.getBoundingClientRect().width) : null
  })
  console.log(PHASE, String(item), 'page width px =', width)
  await p.screenshot({ path: `${OUT}/${PHASE}-0${i + 1}-${String(item).replace(/\W/g, '').toLowerCase()}.png` })
}
await browser.close()
