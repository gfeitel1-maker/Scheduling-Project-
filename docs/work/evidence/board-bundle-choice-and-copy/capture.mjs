import { chromium } from 'playwright'
import fs from 'node:fs'

// Relative to this file, so no personal absolute path enters git history (T120).
const OUT = import.meta.dirname
fs.mkdirSync(OUT, { recursive: true })
const URL = process.env.SHOT_URL || 'http://localhost:5301/'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 2 })
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))

await page.goto(URL)

// Bootstrap a fresh camp (fabricated name/PIN, no real camper data — T120/T249).
await page.getByText("Host this camp's schedule").click()
await page.getByPlaceholder('e.g. Camp Willowbrook').fill('Camp Fixture Test')
await page.getByPlaceholder('e.g. Sarah Cohen').fill('Director Dana')
await page.getByPlaceholder('6 or more digits').fill('123456')
await page.getByRole('button', { name: 'Create camp & continue' }).click()
await page.waitForTimeout(800)

// Seed the full fixture via the SAME mock functions the real UI calls
// (write/commitElectiveRun/finalizeElectiveRun) — not hand-written
// localStorage JSON — so the seeded state is exactly what those functions
// would produce for a real import.
const seedResult = await page.evaluate(async () => {
  const mod = await import('/src/localClient.mock.js')
  const m = mod.mockShoresh
  const w = (entity, entity_id, field, value) => m.write({ entity, entity_id, field, value })
  const campId = (await m.getCamp()).id
  const DAY_MON = `day:${campId}:1`

  await w('tiers', 'tier-older', 'camp_id', campId)
  await w('tiers', 'tier-older', 'name', 'Older')
  await w('tiers', 'tier-younger', 'camp_id', campId)
  await w('tiers', 'tier-younger', 'name', 'Younger')
  await w('groups', 'grp-older', 'camp_id', campId)
  await w('groups', 'grp-older', 'name', 'Bunk 9')
  await w('groups', 'grp-older', 'tier_id', 'tier-older')
  await w('groups', 'grp-younger', 'camp_id', campId)
  await w('groups', 'grp-younger', 'name', 'Bunk 1')
  await w('groups', 'grp-younger', 'tier_id', 'tier-younger')
  await w('time_blocks', 'tb-1', 'camp_id', campId)
  await w('time_blocks', 'tb-1', 'name', 'Period 1')
  await w('time_blocks', 'tb-1', 'start_time', '10:00')
  await w('time_blocks', 'tb-1', 'end_time', '10:40')
  await w('time_blocks', 'tb-1', 'sort_order', 0)
  await w('locations', 'loc-boathouse', 'camp_id', campId)
  await w('locations', 'loc-boathouse', 'name', 'Boathouse')
  await w('locations', 'loc-boathouse', 'capacity', 1)
  await w('activities', 'act-ropes', 'camp_id', campId)
  await w('activities', 'act-ropes', 'name', 'Ropes')
  await w('activities', 'act-climbing', 'camp_id', campId)
  await w('activities', 'act-climbing', 'name', 'Climbing')
  await w('activities', 'act-canoe', 'camp_id', campId)
  await w('activities', 'act-canoe', 'name', 'Canoeing')
  await w('activities', 'act-canoe', 'location_id', 'loc-boathouse')
  await w('activities', 'act-kayak', 'camp_id', campId)
  await w('activities', 'act-kayak', 'name', 'Kayaking')
  await w('activities', 'act-kayak', 'location_id', 'loc-boathouse')
  await w('elective_sets', 'set-1', 'camp_id', campId)
  await w('elective_sets', 'set-1', 'name', 'Afternoon Electives')

  await w('elective_bundles', 'bundle-ropes', 'elective_set_id', 'set-1')
  await w('elective_bundles', 'bundle-ropes', 'activity_id', 'act-ropes')
  await w('elective_bundles', 'bundle-ropes', 'name', 'Ropes')
  await w('elective_bundles', 'bundle-ropes', 'scope_mode', 'only')
  await w('elective_bundle_tiers', 'ebt-ropes', 'bundle_id', 'bundle-ropes')
  await w('elective_bundle_tiers', 'ebt-ropes', 'tier_id', 'tier-older')
  await w('elective_bundle_periods', 'ebp-ropes', 'bundle_id', 'bundle-ropes')
  await w('elective_bundle_periods', 'ebp-ropes', 'day_id', DAY_MON)
  await w('elective_bundle_periods', 'ebp-ropes', 'time_block_id', 'tb-1')

  await w('elective_bundles', 'bundle-climbing', 'elective_set_id', 'set-1')
  await w('elective_bundles', 'bundle-climbing', 'activity_id', 'act-climbing')
  await w('elective_bundles', 'bundle-climbing', 'name', 'Climbing')
  await w('elective_bundles', 'bundle-climbing', 'scope_mode', 'only')
  await w('elective_bundle_tiers', 'ebt-climbing', 'bundle_id', 'bundle-climbing')
  await w('elective_bundle_tiers', 'ebt-climbing', 'tier_id', 'tier-younger')
  await w('elective_bundle_periods', 'ebp-climbing', 'bundle_id', 'bundle-climbing')
  await w('elective_bundle_periods', 'ebp-climbing', 'day_id', DAY_MON)
  await w('elective_bundle_periods', 'ebp-climbing', 'time_block_id', 'tb-1')

  await w('elective_set_activities', 'esa-ropes', 'elective_set_id', 'set-1')
  await w('elective_set_activities', 'esa-ropes', 'activity_id', 'act-ropes')
  await w('elective_set_activities', 'esa-climbing', 'elective_set_id', 'set-1')
  await w('elective_set_activities', 'esa-climbing', 'activity_id', 'act-climbing')
  await w('elective_set_activities', 'esa-canoe', 'elective_set_id', 'set-1')
  await w('elective_set_activities', 'esa-canoe', 'activity_id', 'act-canoe')
  await w('elective_set_activities', 'esa-kayak', 'elective_set_id', 'set-1')
  await w('elective_set_activities', 'esa-kayak', 'activity_id', 'act-kayak')

  await w('schedule_weeks', 'wk-1', 'camp_id', campId)
  await w('schedule_weeks', 'wk-1', 'name', 'Week 1')
  await w('schedule_weeks', 'wk-1', 'sort_order', 0)
  await w('schedule_templates', 'tpl-1', 'camp_id', campId)
  await w('schedule_templates', 'tpl-1', 'week_id', 'wk-1')
  await w('schedule_templates', 'tpl-1', 'kind', 'manual')
  await w('schedule_templates', 'tpl-1', 'name', 'Manual')
  await w('template_slots', 'ts-older-elective', 'template_id', 'tpl-1')
  await w('template_slots', 'ts-older-elective', 'group_id', 'grp-older')
  await w('template_slots', 'ts-older-elective', 'day_id', DAY_MON)
  await w('template_slots', 'ts-older-elective', 'time_block_id', 'tb-1')
  await w('template_slots', 'ts-older-elective', 'elective_set_id', 'set-1')
  await w('template_slots', 'ts-younger-elective', 'template_id', 'tpl-1')
  await w('template_slots', 'ts-younger-elective', 'group_id', 'grp-younger')
  await w('template_slots', 'ts-younger-elective', 'day_id', DAY_MON)
  await w('template_slots', 'ts-younger-elective', 'time_block_id', 'tb-1')
  await w('template_slots', 'ts-younger-elective', 'elective_set_id', 'set-1')
  // Double-book the Boathouse: Canoeing for Older, Kayaking for Younger, same cell.
  await w('template_slots', 'ts-canoe', 'template_id', 'tpl-1')
  await w('template_slots', 'ts-canoe', 'group_id', 'grp-older')
  await w('template_slots', 'ts-canoe', 'day_id', DAY_MON)
  await w('template_slots', 'ts-canoe', 'time_block_id', 'tb-1')
  await w('template_slots', 'ts-canoe', 'activity_id', 'act-canoe')
  await w('template_slots', 'ts-kayak', 'template_id', 'tpl-1')
  await w('template_slots', 'ts-kayak', 'group_id', 'grp-younger')
  await w('template_slots', 'ts-kayak', 'day_id', DAY_MON)
  await w('template_slots', 'ts-kayak', 'time_block_id', 'tb-1')
  await w('template_slots', 'ts-kayak', 'activity_id', 'act-kayak')

  // Run 1: bundle mismatches + sheet-only campers (stays Draft).
  const parsed1 = {
    campers: [
      { id: 'cam-y1', display_name: 'Noa Katz', external_id: null, group_id: null, division_label: 'Younger' },
      { id: 'cam-y2', display_name: 'Tal Bar', external_id: null, group_id: null, division_label: 'Younger' },
      { id: 'cam-o1', display_name: 'Ari Green', external_id: null, group_id: null, division_label: 'Older' },
      { id: 'cam-o2', display_name: 'Bracha Gold', external_id: null, group_id: null, division_label: 'Older' },
      { id: 'cam-sheet1', display_name: 'Shir Cohen', external_id: null, group_id: null, division_label: 'Older' },
      { id: 'cam-sheet2', display_name: 'Omer Levi', external_id: null, group_id: null, division_label: 'Younger' },
    ],
    choices: [{ label: 'Ropes', labelKey: 'ropes' }, { label: 'Climbing', labelKey: 'climbing' }],
    preferences: [
      { camper_id: 'cam-y1', label: 'Ropes', labelKey: 'ropes', rank: 1 },
      { camper_id: 'cam-y2', label: 'Ropes', labelKey: 'ropes', rank: 1 },
      { camper_id: 'cam-o1', label: 'Climbing', labelKey: 'climbing', rank: 1 },
      { camper_id: 'cam-o2', label: 'Climbing', labelKey: 'climbing', rank: 1 },
    ],
    sameNameCampers: [], skippedRows: [],
  }
  const out1 = await m.commitElectiveRun({ name: 'Week 1 — mismatches demo', parsed: parsed1, assignments: [] })

  // Run 2: resource conflict (stays Draft; Finalize will be clicked live).
  const parsed2 = {
    campers: [{ id: 'cam-conflict-1', display_name: 'Conflict Camper', external_id: null, group_id: null, division_label: 'Older' }],
    choices: [{ label: 'Archery', labelKey: 'archery' }],
    preferences: [], sameNameCampers: [], skippedRows: [],
  }
  const occurrences2 = [{ id: 'occ-conflict-1', elective_set_id: 'set-1', day_id: DAY_MON, time_block_id: 'tb-1', tier_id: 'tier-older' }]
  const out2 = await m.commitElectiveRun({
    name: 'Week 2 — resource conflict demo', parsed: parsed2, assignments: [],
    occurrences: occurrences2, scheduleTemplateId: 'tpl-1',
  })

  // Run 3: finalized, with a real director name.
  const parsed3 = {
    campers: [{ id: 'cam-final-1', display_name: 'Finalized Camper', external_id: null, group_id: null, division_label: 'Older' }],
    choices: [{ label: 'Archery', labelKey: 'archery' }],
    preferences: [{ camper_id: 'cam-final-1', label: 'Archery', labelKey: 'archery', rank: 1 }],
    sameNameCampers: [], skippedRows: [],
  }
  const out3 = await m.commitElectiveRun({ name: 'Week 0 — finalized demo', parsed: parsed3, assignments: [] })
  const fin = await m.finalizeElectiveRun({ runId: out3.runId })
  const state = JSON.parse(localStorage.getItem('shoresh-mock-state'))
  const director = (state.users || []).find((u) => u.role === 'admin') || state.users[0]
  state.elective_assignment_runs = state.elective_assignment_runs.map((r) =>
    r.id === out3.runId ? { ...r, finalized_by: director?.id ?? null } : r
  )
  localStorage.setItem('shoresh-mock-state', JSON.stringify(state))

  return { out1, out2, out3, fin, director }
})
console.log('SEED RESULT:', JSON.stringify(seedResult, null, 2))

await page.reload()
await page.waitForTimeout(600)

// ---- Scene 1: Draft run with grouped BUNDLE_TIER_NOT_COVERED + sheet-only campers ----
await page.getByText('Electives', { exact: true }).click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: 'Open', exact: true }).click()
await page.waitForTimeout(500)
await page.getByText('Week 1 — mismatches demo').click()
await page.waitForTimeout(500)
// Expand the sheet-only-campers disclosure and both bundle-mismatch disclosures.
for (const summary of await page.locator('details summary').all()) {
  await summary.click().catch(() => {})
}
await page.waitForTimeout(300)
const scene1Text = await page.locator('main').innerText()
console.log('SCENE 1 TEXT:', JSON.stringify(scene1Text))
await page.screenshot({ path: `${OUT}/scene1-draft-run-mismatches-and-sheet-only.png`, fullPage: true })

// ---- Scene 2: live Finalize click producing an OUTER_RESOURCE_CONFLICT refusal ----
await page.getByText('Back to Runs').click()
await page.waitForTimeout(400)
await page.getByText('Week 2 — resource conflict demo').click()
await page.waitForTimeout(400)
await page.getByRole('button', { name: 'Finalize run' }).click()
await page.waitForTimeout(400)
const scene2Text = await page.locator('main').innerText()
console.log('SCENE 2 TEXT:', JSON.stringify(scene2Text))
await page.screenshot({ path: `${OUT}/scene2-outer-resource-conflict-refusal.png`, fullPage: true })

// ---- Scene 3: cold-opened Final run showing the director's real name ----
await page.getByText('Back to Runs').click()
await page.waitForTimeout(400)
await page.getByText('Week 0 — finalized demo').click()
await page.waitForTimeout(400)
const scene3Text = await page.locator('main').innerText()
console.log('SCENE 3 TEXT:', JSON.stringify(scene3Text))
await page.screenshot({ path: `${OUT}/scene3-finalized-run-director-name.png`, fullPage: true })

console.log('PAGE ERRORS:', errors.length ? errors : 'none')
await browser.close()
