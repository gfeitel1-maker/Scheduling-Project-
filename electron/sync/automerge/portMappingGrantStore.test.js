// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFileGrantStore } from './portMappingGrantStore.js'

let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grant-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('file grantStore', () => {
  it('round-trips the granted external port and leaves no temp file behind', () => {
    const file = path.join(dir, 'g.json')
    const store = createFileGrantStore(file)
    expect(store.load()).toBe(null)
    store.save({ externalPort: 61000 })
    expect(createFileGrantStore(file).load()).toEqual({ externalPort: 61000 })
    expect(fs.readdirSync(dir)).toEqual(['g.json'])
  })

  it('clear removes the record; clearing a missing record is not an error', () => {
    const store = createFileGrantStore(path.join(dir, 'g.json'))
    store.save({ externalPort: 61000 })
    store.clear()
    expect(store.load()).toBe(null)
    expect(() => store.clear()).not.toThrow()
  })

  it('a corrupt or out-of-range record loads as nothing', () => {
    const file = path.join(dir, 'g.json')
    const store = createFileGrantStore(file)
    for (const bad of ['{not json', '{"externalPort":0}', '{"externalPort":70000}', '{"externalPort":"61000"}', '[]']) {
      fs.writeFileSync(file, bad)
      expect(store.load()).toBe(null)
    }
  })

  it('refuses to save a port outside 1-65535', () => {
    const store = createFileGrantStore(path.join(dir, 'g.json'))
    expect(() => store.save({ externalPort: 99999 })).toThrow()
  })
})
