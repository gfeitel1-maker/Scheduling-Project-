// CR4 — a real two-machine libp2p + Automerge node. Run it on each machine:
//   node cr4-node.mjs                      (auto-discovers peers on the SAME Wi-Fi via mDNS)
//   node cr4-node.mjs --dial <multiaddr>   (manual connect, e.g. across networks when reachable)
//
// Then type:  edit archery location "Field 1"   on one machine and watch it appear on the other.
// Commands: edit <entity> <field> <value> | state | peers | quit
//
// This is the pure-P2P analog of the Syncthing test: no daemon, no public relay, no account —
// libp2p (encrypted, mDNS discovery, hole-punch-ready via dcutr) carrying Automerge changes,
// converging live. Data/merge = Automerge (surfaces conflicts); transport = libp2p.
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { mdns } from '@libp2p/mdns'
import { dcutr } from '@libp2p/dcutr'
import { pipe } from 'it-pipe'
import { encode, decode } from 'it-length-prefixed'
import * as A from '@automerge/automerge'
import crypto from 'node:crypto'
import readline from 'node:readline'

const PROTO = '/shoresh/automerge/1.0.0'
// Shared genesis so every node's doc has common ancestry → clean merges. A.clone
// gives THIS node a unique actor id while keeping that shared history.
const GENESIS = 'hW9Kg6gGAWAApQEBEOwZNyQ3rioMV7TtzKM2k3UBvwdao2opxw1SeNXssZYVNrKJ5gNMtp5NZmnr/bhYnPgGAQIDAhMCIwZAAlYCDAEEAgQRBBMHFQghAiMCNAJCBFYEVw+AAQJ/AH8BfxB/udHy1AZ/AH8HAAEPAAABDwEAAg4AAAF+AAINAX8EY2FtcAAPEAAQAQEPfwQPAX8ADxZDYW1wIEFjaHZhIDIwMjcQAAA='
let doc = A.clone(A.load(new Uint8Array(Buffer.from(GENESIS, 'base64'))))

const dialArgIdx = process.argv.indexOf('--dial')
const dialTarget = dialArgIdx >= 0 ? process.argv[dialArgIdx + 1] : null

function entities () {
  return Object.entries(doc).filter(([, v]) => v && typeof v === 'object')
}
function stateHash () {
  const rows = entities().map(([id, e]) => [id, e.name ?? null, e.location ?? null]).sort()
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16)
}
function printState (prefix = 'state') {
  console.log('\n' + prefix + '  (hash ' + stateHash() + ')')
  const es = entities()
  if (es.length === 0) console.log('  (no activities yet)')
  for (const [id, e] of es) {
    let line = '  ' + id.padEnd(12) + ' name=' + (e.name ?? '·') + '  location=' + (e.location ?? '·')
    const c = A.getConflicts(e, 'location')
    if (c && Object.keys(c).length > 1) line += '   ⚠ CONFLICT: ' + JSON.stringify(Object.values(c))
    console.log(line)
  }
}

const node = await createLibp2p({
  addresses: { listen: ['/ip4/0.0.0.0/tcp/' + (process.env.PORT || '0')] }, // set PORT=9701 for a stable address
  transports: [tcp()],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  peerDiscovery: [mdns()],
  services: { identify: identify(), dcutr: dcutr() },
})

// --- receive: merge a peer's doc; if it changed us, reflect + gossip onward ---
await node.handle(PROTO, ({ stream, connection }) => {
  pipe(stream.source, (s) => decode(s), async (source) => {
    for await (const framed of source) {
      const before = A.getHeads(doc)
      doc = A.merge(doc, A.load(framed.subarray()))
      if (JSON.stringify(A.getHeads(doc)) !== JSON.stringify(before)) {
        printState('◀ update from ' + connection.remotePeer.toString().slice(0, 12) + '…')
        broadcast(connection.remotePeer) // gossip to other peers (skip the sender)
      }
    }
  }).catch((e) => console.error('rx error:', e.message))
})

async function sendDocTo (peerId) {
  try {
    const stream = await node.dialProtocol(peerId, PROTO)
    await pipe([A.save(doc)], (s) => encode(s), stream.sink)
  } catch (e) { /* peer may have gone; ignore */ }
}
function broadcast (except) {
  for (const peer of node.getPeers()) {
    if (except && peer.toString() === except.toString()) continue
    sendDocTo(peer)
  }
}

// auto-discover on the LAN and connect
node.addEventListener('peer:discovery', (evt) => { node.dial(evt.detail.id).catch(() => {}) })
// on any new connection, push our doc so both sides converge immediately
node.addEventListener('connection:open', (evt) => {
  console.log('  ✔ connected to ' + evt.detail.remotePeer.toString().slice(0, 12) + '…')
  sendDocTo(evt.detail.remotePeer)
})

if (dialTarget) {
  const { multiaddr } = await import('@multiformats/multiaddr')
  await node.dial(multiaddr(dialTarget)).catch((e) => console.error('dial failed:', e.message))
}

console.log('=== CR4 node up ===')
console.log('peerId: ' + node.peerId.toString())
console.log('listening on (give one of these to the other machine as --dial):')
for (const ma of node.getMultiaddrs()) console.log('  ' + ma.toString())
console.log('\nType:  edit archery location "Field 1"   |   state   |   peers   |   quit')

// --- simple CLI ---------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' })
rl.prompt()
rl.on('line', (line) => {
  const m = line.trim().match(/^edit\s+(\S+)\s+(name|location)\s+"?([^"]*)"?\s*$/)
  if (m) {
    const [, id, field, value] = m
    doc = A.change(doc, (d) => { if (!d[id]) d[id] = {}; d[id][field] = value })
    printState('▶ your edit')
    broadcast()
  } else if (line.trim() === 'state') { printState()
  } else if (line.trim() === 'peers') { console.log('  connected peers: ' + node.getPeers().map((p) => p.toString().slice(0, 12) + '…').join(', ') || '  (none)')
  } else if (line.trim() === 'quit' || line.trim() === 'exit') { node.stop().then(() => process.exit(0)); return
  } else if (line.trim()) { console.log('  commands: edit <entity> <name|location> <value> | state | peers | quit') }
  rl.prompt()
})
