// @vitest-environment node
// T340: startSyncNode forwards the profile fields to startTransport.
import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openLocalDb } from '../../db/localDb.js'
import { createEmptyDoc } from '../../automerge/campDocument.js'

const seen = {}
vi.mock('./transport.js', async (orig) => ({
  ...(await orig()),
  startTransport: async (opts) => { seen.opts = opts; throw new Error('stop-after-transport') },
}))
const { startSyncNode } = await import('./syncNode.js')

let file
afterEach(() => { if (file && fs.existsSync(file)) fs.unlinkSync(file) })

describe('startSyncNode pending profile', () => {
  it('passes globalPending and publicSubCap to startTransport', async () => {
    file = path.join(os.tmpdir(), `shoresh-pp-${Date.now()}-${Math.random()}.sqlite`)
    const db = openLocalDb(file)
    db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run('camp-1', 'Camp One')
    await expect(startSyncNode({ deviceId: 'd', db, doc: createEmptyDoc(), pendingProfile: { globalPending: 128, publicSubCap: 32 } })).rejects.toThrow('stop-after-transport')
    expect(seen.opts.maxIncomingPendingConnections).toBe(128)
    expect(seen.opts.maxPublicPendingTotal).toBe(32)
    db.close()
  })
})
