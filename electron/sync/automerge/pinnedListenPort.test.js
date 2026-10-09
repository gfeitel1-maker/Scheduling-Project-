// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { resolveTcpListenAddr, TCP_PORT_FILE } from './pinnedListenPort.js'

let dir
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pinport-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

const occupy = (port = 0) => new Promise((resolve) => {
  const s = net.createServer()
  s.listen(port, '0.0.0.0', () => resolve(s))
})

describe('resolveTcpListenAddr', () => {
  it('picks a port in the dynamic range on first run and returns the same one next time', async () => {
    const a = await resolveTcpListenAddr({ userDataPath: dir })
    expect(a.status).toBe('ok')
    expect(a.port).toBeGreaterThanOrEqual(49152)
    expect(a.port).toBeLessThan(65536)
    expect(a.listenAddr).toBe(`/ip4/0.0.0.0/tcp/${a.port}`)
    const b = await resolveTcpListenAddr({ userDataPath: dir })
    expect(b.port).toBe(a.port)
  })

  it('falls back to an ephemeral port on a bind conflict, reports port-in-use, keeps the persisted port', async () => {
    const server = await occupy()
    const taken = server.address().port
    fs.writeFileSync(path.join(dir, TCP_PORT_FILE), JSON.stringify({ port: taken }))
    try {
      const r = await resolveTcpListenAddr({ userDataPath: dir })
      expect(r).toEqual({ listenAddr: '/ip4/0.0.0.0/tcp/0', port: 0, status: 'port-in-use' })
      expect(JSON.parse(fs.readFileSync(path.join(dir, TCP_PORT_FILE), 'utf8')).port).toBe(taken)
    } finally {
      server.close()
    }
  })

  it('replaces an unreadable or out-of-range file with a fresh port', async () => {
    fs.writeFileSync(path.join(dir, TCP_PORT_FILE), '{not json')
    const a = await resolveTcpListenAddr({ userDataPath: dir })
    expect(a.status).toBe('ok')
    fs.writeFileSync(path.join(dir, TCP_PORT_FILE), JSON.stringify({ port: 80 }))
    const b = await resolveTcpListenAddr({ userDataPath: dir })
    expect(b.port).toBeGreaterThanOrEqual(49152)
  })
})
