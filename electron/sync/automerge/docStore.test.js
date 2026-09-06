// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { docPath, saveDoc, loadDoc } from './docStore.js'
import { createEmptyDoc, applyWrite } from '../../automerge/campDocument.js'

const CAMP_ID = 'camp-123'

let userDataDir

beforeEach(() => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-docstore-test-'))
})

afterEach(() => {
  fs.rmSync(userDataDir, { recursive: true, force: true })
})

describe('docPath', () => {
  it('places the doc under <userDataDir>/automerge/<campId>.automerge', () => {
    expect(docPath(userDataDir, CAMP_ID)).toBe(
      path.join(userDataDir, 'automerge', `${CAMP_ID}.automerge`)
    )
  })
})

describe('loadDoc', () => {
  it('returns null when no file exists yet', () => {
    expect(loadDoc(userDataDir, CAMP_ID)).toBeNull()
  })
})

describe('saveDoc / loadDoc round trip', () => {
  it('creates the automerge/ directory if missing', () => {
    const doc = createEmptyDoc()
    expect(fs.existsSync(path.join(userDataDir, 'automerge'))).toBe(false)
    saveDoc(userDataDir, CAMP_ID, doc)
    expect(fs.existsSync(path.join(userDataDir, 'automerge'))).toBe(true)
  })

  it('round-trips a doc with a couple of entities', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A' })
    doc = applyWrite(doc, {
      entity: 'activities',
      entity_id: 'a1',
      field: 'name',
      value: 'Swim'
    })

    saveDoc(userDataDir, CAMP_ID, doc)
    const loaded = loadDoc(userDataDir, CAMP_ID)

    expect(loaded.groups.g1.name).toBe('Bunk A')
    expect(loaded.activities.a1.name).toBe('Swim')
  })

  it('leaves no temp file behind and a valid file after a save', () => {
    const doc = createEmptyDoc()
    saveDoc(userDataDir, CAMP_ID, doc)

    const files = fs.readdirSync(path.join(userDataDir, 'automerge'))
    expect(files).toEqual([`${CAMP_ID}.automerge`])
  })

  it('overwriting an existing doc works', () => {
    let doc = createEmptyDoc()
    doc = applyWrite(doc, { entity: 'groups', entity_id: 'g1', field: 'name', value: 'Bunk A' })
    saveDoc(userDataDir, CAMP_ID, doc)

    let doc2 = createEmptyDoc()
    doc2 = applyWrite(doc2, { entity: 'groups', entity_id: 'g2', field: 'name', value: 'Bunk B' })
    saveDoc(userDataDir, CAMP_ID, doc2)

    const loaded = loadDoc(userDataDir, CAMP_ID)
    expect(loaded.groups.g1).toBeUndefined()
    expect(loaded.groups.g2.name).toBe('Bunk B')

    const files = fs.readdirSync(path.join(userDataDir, 'automerge'))
    expect(files).toEqual([`${CAMP_ID}.automerge`])
  })
})
