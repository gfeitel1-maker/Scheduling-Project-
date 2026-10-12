// @vitest-environment node
// T345 keeper condition B: the suspend gate lives where the bytes are written (docStore.saveDoc), so the
// purge support command, which saves through docStore directly, cannot land a document during or after a
// disable either.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { saveDoc, docPath, suspendDocSaves } from './docStore.js'
import { suspendDocSaves as suspendViaLiveDoc } from './liveDoc.js'
import { createEmptyDoc } from '../../automerge/campDocument.js'

const dirs = []
afterEach(() => { suspendDocSaves(false); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }) })
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-docstore-')); dirs.push(d); return d }

describe('docStore.saveDoc while saves are suspended', () => {
  it('refuses with a coded error and writes nothing', () => {
    const dir = tmp()
    suspendDocSaves(true)
    expect(() => saveDoc(dir, 'c1', createEmptyDoc())).toThrow(expect.objectContaining({ code: 'doc_saves_suspended' }))
    expect(fs.existsSync(docPath(dir, 'c1'))).toBe(false)
  })

  it('writes again once saves are re-enabled', () => {
    const dir = tmp()
    suspendDocSaves(true)
    suspendDocSaves(false)
    saveDoc(dir, 'c1', createEmptyDoc())
    expect(fs.existsSync(docPath(dir, 'c1'))).toBe(true)
  })

  it("liveDoc's suspend switch is the same gate, so the runner's call reaches the purge path", () => {
    const dir = tmp()
    suspendViaLiveDoc(true)
    expect(() => saveDoc(dir, 'c1', createEmptyDoc())).toThrow(expect.objectContaining({ code: 'doc_saves_suspended' }))
    suspendViaLiveDoc(false)
  })
})
