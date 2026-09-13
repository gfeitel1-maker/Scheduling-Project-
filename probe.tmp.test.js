import { it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'; import path from 'node:path'; import { randomUUID } from 'node:crypto'
import { openLocalDb } from './electron/db/localDb.js'
import { commitIngest } from './electron/ops/ingest.js'
it('probe', () => {
  const db = openLocalDb(path.join(os.tmpdir(), `p-${Date.now()}-${Math.random()}.sqlite`))
  const campId = randomUUID()
  db.prepare('INSERT INTO camps (id, name, signing_secret) VALUES (?, ?, ?)').run(campId, 'C', 'a'.repeat(64))
  db.prepare('INSERT INTO devices (id, name) VALUES (?, ?)').run('d1', 'D')
  db.prepare("INSERT INTO users (id, camp_id, name, pin_hash, pin_salt, role) VALUES (?, ?, 'R', 'h', 's', 'admin')").run('u1', campId)
  const r = commitIngest(db, {
    approved: { groups: ['Tzofim 1','Tzofim 2','Tzofim 3'], activities: ['Lunch 1'] },
    activityRules: { 'Lunch 1': { eligible_group_names: ['Tzofim 1'], min_per_week: 5, max_per_week: 5, priority: 'high', co_schedule: { max_groups_per_slot: 3, same_tier_only: true, co_schedule_groups: ['a'], support: {} } } },
    camp_id: campId, device_id: 'd1',
  })
  fs.writeFileSync('/tmp/probe.out', JSON.stringify(r).slice(0, 1200) + '\n' +
    JSON.stringify(db.prepare('SELECT name,min_per_week,max_groups_per_slot,same_tier_only FROM activities').all()))
})
