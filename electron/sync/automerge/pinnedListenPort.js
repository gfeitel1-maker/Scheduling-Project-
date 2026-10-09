// T359 slice 1: the libp2p TCP listener must sit on a stable port before a router can be asked to map
// it. The port is a device-local number (not a secret, never synced) kept in a small file in userData
// rather than a schema column. A bind conflict falls back to an ephemeral port and reports
// 'port-in-use'; the persisted port is kept so the next start tries it again.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { randomInt } from 'node:crypto'

export const TCP_PORT_FILE = 'tcp-listen-port.json'
const MIN_PORT = 49152
const EPHEMERAL = '/ip4/0.0.0.0/tcp/0'

const readPort = (file) => {
  try {
    const { port } = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Number.isInteger(port) && port >= MIN_PORT && port < 65536 ? port : null
  } catch {
    return null
  }
}

const writePort = (file, port) => {
  try {
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ port }))
    fs.renameSync(`${file}.tmp`, file)
  } catch (err) {
    console.warn(`pinned listen port: could not persist (${err?.code ?? 'error'}); the port is used for this run only`)
  }
}

const canBind = (port) =>
  new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '0.0.0.0', () => server.close(() => resolve(true)))
  })

export async function resolveTcpListenAddr({ userDataPath }) {
  const file = path.join(userDataPath, TCP_PORT_FILE)
  let port = readPort(file)
  const fresh = port === null
  if (fresh) port = randomInt(MIN_PORT, 65536)
  if (!(await canBind(port))) return { listenAddr: EPHEMERAL, port: 0, status: 'port-in-use' }
  if (fresh) writePort(file, port)
  return { listenAddr: `/ip4/0.0.0.0/tcp/${port}`, port, status: 'ok' }
}
