// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../db/localDb.js'
import { createEmptyDoc, applyWrite } from './campDocument.js'
import { projectEntity } from './projector.js'
import { MAX_FIELD_VALUE_LENGTH } from '../ops/operations.js'

const CAP = MAX_FIELD_VALUE_LENGTH.camp_maps.image_data
let file
let db
beforeEach(() => {
  file = path.join(os.tmpdir(), `shoresh-fieldlen-${Date.now()}-${Math.random()}.sqlite`)
  db = openLocalDb(file)
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
})
afterEach(() => {
  try { db.close() } catch { /* already closed */ }
  if (fs.existsSync(file)) fs.unlinkSync(file)
  vi.restoreAllMocks()
})

function docWithMap(id, imageData) {
  let doc = createEmptyDoc()
  const w = (field, value) => { doc = applyWrite(doc, { entity: 'camp_maps', entity_id: id, field, value }) }
  w('camp_id', 'camp-1')
  w('kind', 'indoor')
  w('image_mime', 'image/png')
  w('image_data', imageData)
  return doc
}
const imageLen = (id) => db.prepare('SELECT length(image_data) AS n FROM camp_maps WHERE id = ?').get(id)

describe('merged-document projection enforces MAX_FIELD_VALUE_LENGTH', () => {
  it('refuses an over-length value, keeps sibling fields, warns without the value', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const secret = 'Z'.repeat(CAP + 1)
    projectEntity(db, docWithMap('m1', secret), 'camp_maps')
    const row = db.prepare('SELECT camp_id, image_mime, image_data FROM camp_maps WHERE id = ?').get('m1')
    expect(row.image_data).toBeNull()
    expect(row.image_mime).toBe('image/png')
    expect(warn).toHaveBeenCalled()
    expect(JSON.stringify(warn.mock.calls)).not.toContain('ZZZZ')
  })

  it('accepts a value of exactly the cap', () => {
    projectEntity(db, docWithMap('m1', 'a'.repeat(CAP)), 'camp_maps')
    expect(imageLen('m1').n).toBe(CAP)
  })

  it('leaves the existing value unchanged and still projects other records', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    projectEntity(db, docWithMap('m1', 'good'), 'camp_maps')
    let doc = docWithMap('m1', 'x'.repeat(CAP + 1))
    doc = applyWrite(doc, { entity: 'camp_maps', entity_id: 'm2', field: 'camp_id', value: 'camp-1' })
    doc = applyWrite(doc, { entity: 'camp_maps', entity_id: 'm2', field: 'kind', value: 'outdoor' })
    projectEntity(db, doc, 'camp_maps')
    expect(db.prepare('SELECT image_data FROM camp_maps WHERE id = ?').get('m1').image_data).toBe('good')
    expect(db.prepare('SELECT kind FROM camp_maps WHERE id = ?').get('m2').kind).toBe('outdoor')
  })
})
