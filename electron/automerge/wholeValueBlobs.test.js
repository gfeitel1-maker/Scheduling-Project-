// @vitest-environment node
// Whole-value JSON blobs are written as ImmutableString, one op per write
// (docs/adr/2026-10-10-whole-value-blobs-as-immutable-strings.md). As Automerge Text they cost one
// op per character, kept forever in history: an imported camp reached 2.9M ops this way and took
// seconds of CPU just to load. Budgets count ops, never wall clock.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as A from '@automerge/automerge'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { createEmptyDoc, applyWrite, applyBulkReplace, readRecord } from './campDocument.js'
import { projectAll } from './projector.js'
import { reconcile, resolveConflictInDoc } from './reconcile.js'

const opsInLastChange = (doc) => {
  const meta = A.getChangesMetaSince(doc, [])
  const last = meta[meta.length - 1]
  return last.maxOp - last.startOp + 1
}

const slotRows = (n, prefix) => Array.from({ length: n }, (_, i) => ({
  id: `${prefix}-${i}`, template_id: 'tpl-1', group_id: null, activity_id: null, day_id: null, time_block_id: null,
}))

let db, file
beforeEach(() => {
  file = path.join(os.tmpdir(), `whole-value-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(file)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
})
afterEach(() => {
  db.close()
  for (const s of ['', '-wal', '-shm']) if (fs.existsSync(file + s)) fs.unlinkSync(file + s)
})

describe('op budget', () => {
  it('a regenerate (bulk replace of 2000 slots) is a handful of ops, not one per character', () => {
    let doc = createEmptyDoc()
    doc = applyBulkReplace(doc, { entity: 'template_slots', scope_id: 'tpl-1', rows: slotRows(2000, 'g1') })
    expect(JSON.stringify(slotRows(2000, 'g1')).length).toBeGreaterThan(100_000)
    expect(opsInLastChange(doc)).toBeLessThanOrEqual(5)
    doc = applyBulkReplace(doc, { entity: 'template_slots', scope_id: 'tpl-1', rows: slotRows(2000, 'g2') })
    expect(opsInLastChange(doc)).toBeLessThanOrEqual(5)
  })

  it('a saved schedule version is a handful of ops, not one per character', () => {
    let doc = createEmptyDoc()
    const slots = JSON.stringify(slotRows(2000, 's'))
    doc = applyWrite(doc, { entity: 'schedule_snapshots', entity_id: 'snap-1', field: 'slots', value: slots })
    expect(opsInLastChange(doc)).toBeLessThanOrEqual(5)
    expect(readRecord(doc, 'schedule_snapshots', 'snap-1').slots).toBe(slots)
  })

  it('a camp map image is a handful of ops, not one per character', () => {
    let doc = createEmptyDoc()
    const image = 'data:image/png;base64,' + 'A'.repeat(500_000)
    doc = applyWrite(doc, { entity: 'camp_maps', entity_id: 'map-1', field: 'image_data', value: image })
    expect(opsInLastChange(doc)).toBeLessThanOrEqual(5)
    expect(readRecord(doc, 'camp_maps', 'map-1').image_data).toBe(image)
  })

  it('ordinary short text fields are unchanged (still Text)', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: 'schedule_snapshots', entity_id: 'snap-1', field: 'name', value: 'Before lunch swap' })
    const key = Object.keys(doc.schedule_snapshots).find((k) => k.endsWith('name'))
    expect(A.isImmutableString(doc.schedule_snapshots[key])).toBe(false)
  })
})

// Text written before this change and ImmutableString written after it, in one document.
function mixedDoc() {
  let doc = createEmptyDoc()
  doc = applyWrite(doc, { entity: 'schedule_templates', entity_id: 'tpl-1', field: 'kind', value: 'manual' })
  doc = applyWrite(doc, { entity: 'schedule_templates', entity_id: 'tpl-1', field: 'camp_id', value: 'camp-1' })
  doc = applyWrite(doc, { entity: 'schedule_templates', entity_id: 'tpl-2', field: 'kind', value: 'generated' })
  doc = applyWrite(doc, { entity: 'schedule_templates', entity_id: 'tpl-2', field: 'camp_id', value: 'camp-1' })
  const oldSlots = JSON.stringify(slotRows(3, 'old').map((r) => ({ ...r, template_id: 'tpl-2' })))
  doc = A.change(doc, (d) => {
    d.template_slots_scopes['tpl-2'] = oldSlots
    d.schedule_snapshots['snap-old\u0000template_id'] = 'tpl-1'
    d.schedule_snapshots['snap-old\u0000slots'] = '[{"old":true}]'
  })
  doc = applyBulkReplace(doc, { entity: 'template_slots', scope_id: 'tpl-1', rows: slotRows(2, 'new') })
  doc = applyWrite(doc, { entity: 'schedule_snapshots', entity_id: 'snap-new', field: 'template_id', value: 'tpl-1' })
  doc = applyWrite(doc, { entity: 'schedule_snapshots', entity_id: 'snap-new', field: 'slots', value: '[{"new":true}]' })
  return doc
}

describe('a document holding both old Text blobs and new ImmutableString blobs', () => {
  it('reads both as plain strings', () => {
    const doc = mixedDoc()
    expect(A.isImmutableString(doc.template_slots_scopes['tpl-1'])).toBe(true)
    expect(A.isImmutableString(doc.template_slots_scopes['tpl-2'])).toBe(false)
    expect(readRecord(doc, 'schedule_snapshots', 'snap-old').slots).toBe('[{"old":true}]')
    expect(readRecord(doc, 'schedule_snapshots', 'snap-new').slots).toBe('[{"new":true}]')
  })

  it('projects both kinds into SQLite', () => {
    projectAll(db, mixedDoc())
    const slotIds = db.prepare('SELECT id FROM template_slots ORDER BY id').all().map((r) => r.id)
    expect(slotIds).toEqual(['new-0', 'new-1', 'old-0', 'old-1', 'old-2'])
    const snaps = Object.fromEntries(db.prepare('SELECT id, slots FROM schedule_snapshots').all().map((r) => [r.id, r.slots]))
    expect(snaps).toEqual({ 'snap-old': '[{"old":true}]', 'snap-new': '[{"new":true}]' })
  })

  // Pins Automerge's own behaviour rather than ours: getConflicts already returns an
  // ImmutableString as a plain string, so a Text and an ImmutableString holding the same JSON
  // compare equal in reconcile.js's sameValue and raise no prompt.
  it('a concurrent old-Text and new-ImmutableString write of the same value is not a conflict', () => {
    const base = mixedDoc()
    let a = A.clone(base, { actor: 'aa'.repeat(16) })
    let b = A.clone(base, { actor: 'bb'.repeat(16) })
    a = A.change(a, (d) => { d.schedule_snapshots['snap-new\u0000slots'] = '[{"same":1}]' })
    b = applyWrite(b, { entity: 'schedule_snapshots', entity_id: 'snap-new', field: 'slots', value: '[{"same":1}]' })
    const { conflicts } = reconcile(A.merge(a, b))
    expect(conflicts.filter((c) => c.field === 'slots')).toEqual([])
  })

  it('resolving a slots conflict writes the chosen value as ImmutableString', () => {
    const base = mixedDoc()
    let a = A.clone(base, { actor: 'aa'.repeat(16) })
    let b = A.clone(base, { actor: 'bb'.repeat(16) })
    a = applyWrite(a, { entity: 'schedule_snapshots', entity_id: 'snap-new', field: 'slots', value: '[1]' })
    b = applyWrite(b, { entity: 'schedule_snapshots', entity_id: 'snap-new', field: 'slots', value: '[2]' })
    const merged = A.merge(a, b)
    const conflict = reconcile(merged).conflicts.find((c) => c.field === 'slots')
    expect(conflict.values.map((v) => v.value).sort()).toEqual(['[1]', '[2]'])
    const resolved = resolveConflictInDoc(merged, { entity: 'schedule_snapshots', entityId: 'snap-new', field: 'slots', value: '[2]' })
    expect(A.isImmutableString(resolved.schedule_snapshots['snap-new\u0000slots'])).toBe(true)
    expect(readRecord(resolved, 'schedule_snapshots', 'snap-new').slots).toBe('[2]')
  })
})
