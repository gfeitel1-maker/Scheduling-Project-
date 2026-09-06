// CR4-DHT — cross-network node using PUBLIC coordination only (no relay you run,
// no data through a relay). Model: pair once on the SAME Wi-Fi (mDNS saves the
// peer's stable id), then across DIFFERENT networks the Kademlia DHT resolves that
// peer's CURRENT address, and dcutr hole-punches a DIRECT connection (public relays
// used only to coordinate the punch). Data = Automerge, direct peer-to-peer.
//
//   node cr4-dht-node.mjs
//
// Commands: edit <entity> <field> <value> | state | peers | known | quit
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { mdns } from '@libp2p/mdns'
import { dcutr } from '@libp2p/dcutr'
import { kadDHT } from '@libp2p/kad-dht'
import { bootstrap } from '@libp2p/bootstrap'
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2'
import { autoNAT } from '@libp2p/autonat'
import { generateKeyPair, privateKeyToProtobuf, privateKeyFromProtobuf } from '@libp2p/crypto/keys'
import { peerIdFromString } from '@libp2p/peer-id'
import { pipe } from 'it-pipe'
import { encode, decode } from 'it-length-prefixed'
import * as A from '@automerge/automerge'
import crypto from 'node:crypto'
import fs from 'node:fs'
import readline from 'node:readline'

const PROTO = '/shoresh/automerge/1.0.0'
const GENESIS = 'hW9Kg6gGAWAApQEBEOwZNyQ3rioMV7TtzKM2k3UBvwdao2opxw1SeNXssZYVNrKJ5gNMtp5NZmnr/bhYnPgGAQIDAhMCIwZAAlYCDAEEAgQRBBMHFQghAiMCNAJCBFYEVw+AAQJ/AH8BfxB/udHy1AZ/AH8HAAEPAAABDwEAAg4AAAF+AAINAX8EY2FtcAAPEAAQAQEPfwQPAX8ADxZDYW1wIEFjaHZhIDIwMjcQAAA='
// Canonical public libp2p/IPFS bootstrap nodes — entry into the PUBLIC DHT.
const BOOTSTRAP = [
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmQCU2EcMqAqQPR2i9bChDtGNJchTbq5TbXJJ16u19uLTa',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb',
  '/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt',
]

// --- persist a STABLE identity + known peers (so LAN pairing survives restarts) ---
async function loadOrCreateKey () {
  if (fs.existsSync('./identity.key')) return privateKeyFromProtobuf(fs.readFileSync('./identity.key'))
  const k = await generateKeyPair('Ed25519')
  fs.writeFileSync('./identity.key', privateKeyToProtobuf(k))
  return k
}
const knownPath = './known-peers.json'
const known = fs.existsSync(knownPath) ? JSON.parse(fs.readFileSync(knownPath, 'utf8')) : []
function remember (peerIdStr) {
  if (!known.includes(peerIdStr)) { known.push(peerIdStr); fs.writeFileSync(knownPath, JSON.stringify(known, null, 2)); console.log('  🔑 paired + saved peer ' + peerIdStr.slice(0, 16) + '…') }
}

let doc = A.clone(A.load(new Uint8Array(Buffer.from(GENESIS, 'base64'))))
const entities = () => Object.entries(doc).filter(([, v]) => v && typeof v === 'object')
const stateHash = () => crypto.createHash('sha256').update(JSON.stringify(entities().map(([id, e]) => [id, e.name ?? null, e.location ?? null]).sort())).digest('hex').slice(0, 16)
function printState (prefix = 'state') {
  console.log('\n' + prefix + '  (hash ' + stateHash() + ')')
  for (const [id, e] of entities()) {
    let line = '  ' + id.padEnd(12) + ' name=' + (e.name ?? '·') + '  location=' + (e.location ?? '·')
    const c = A.getConflicts(e, 'location')
    if (c && Object.keys(c).length > 1) line += '   ⚠ CONFLICT: ' + JSON.stringify(Object.values(c))
    console.log(line)
  }
  if (entities().length === 0) console.log('  (no activities yet)')
}

const node = await createLibp2p({
  privateKey: await loadOrCreateKey(),
  addresses: { listen: ['/ip4/0.0.0.0/tcp/0', '/p2p-circuit'] }, // tcp + reachable-via-relay for the punch
  transports: [tcp(), circuitRelayTransport({ discoverRelays: 2 })],
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  peerDiscovery: [mdns(), bootstrap({ list: BOOTSTRAP })],
  services: {
    identify: identify(),
    dcutr: dcutr(),                       // Direct Connection Upgrade (hole punch)
    autoNAT: autoNAT(),                   // learns our public reachability (STUN-analog)
    dht: kadDHT({ clientMode: false }),   // public DHT: resolve a known peer's current address
  },
})

// --- Automerge live sync (same as CR4) ---------------------------------------
await node.handle(PROTO, ({ stream, connection }) => {
  remember(connection.remotePeer.toString()) // a peer speaking our protocol = a Shoresh node
  // (handler registered with runOnLimitedConnection so it works over a relayed link)
  pipe(stream.source, (s) => decode(s), async (source) => {
    for await (const framed of source) {
      const before = A.getHeads(doc)
      doc = A.merge(doc, A.load(framed.subarray()))
      if (JSON.stringify(A.getHeads(doc)) !== JSON.stringify(before)) { printState('◀ update from ' + connection.remotePeer.toString().slice(0, 12) + '…'); broadcast(connection.remotePeer) }
    }
  }).catch(() => {})
}, { runOnLimitedConnection: true })
async function sendDocTo (peerId) { try { const s = await node.dialProtocol(peerId, PROTO, { runOnLimitedConnection: true }); await pipe([A.save(doc)], (x) => encode(x), s.sink) } catch {} }
// SECURITY: only ever sync with peers we've PAIRED with (they speak our protocol).
// On the public DHT you connect to hundreds of random peers — never send them data.
function broadcast (except) { for (const p of node.getPeers()) { const s = p.toString(); if (except && s === except.toString()) continue; if (!known.includes(s)) continue; sendDocTo(p) } }

node.addEventListener('peer:discovery', (evt) => { node.dial(evt.detail.id).catch(() => {}) })
// Only LOG raw connections (most are DHT infrastructure — do NOT pair or sync here).
node.addEventListener('connection:open', (evt) => {
  const via = evt.detail.remoteAddr?.toString().includes('p2p-circuit') ? 'via relay — dcutr will punch' : 'DIRECT'
  if (known.includes(evt.detail.remotePeer.toString())) console.log('  ✔ connected to paired peer ' + evt.detail.remotePeer.toString().slice(0, 12) + '… (' + via + ')')
})
// PAIR + SYNC only with peers that actually speak our Shoresh protocol (a Shoresh node),
// discovered after identify — this gates out every random DHT/bootstrap peer.
node.addEventListener('peer:identify', (evt) => {
  const { peerId, protocols } = evt.detail
  if (!protocols?.includes(PROTO)) return           // not a Shoresh peer → ignore
  remember(peerId.toString())
  sendDocTo(peerId)
})

// Cross-network: every 20s, resolve each KNOWN peer's current address via the DHT and dial
setInterval(async () => {
  const connected = new Set(node.getPeers().map((p) => p.toString()))
  for (const pidStr of known) {
    if (connected.has(pidStr)) continue
    try {
      const info = await node.peerRouting.findPeer(peerIdFromString(pidStr), { signal: AbortSignal.timeout(15000) })
      console.log('  🔎 DHT found ' + pidStr.slice(0, 12) + '… at ' + info.multiaddrs.length + ' addr(s) — dialing (dcutr will try to punch direct)')
      await node.dial(info.id).catch((e) => console.log('    dial: ' + e.message))
    } catch { /* not found this round; the DHT is slow — try again next tick */ }
  }
}, 20000)

console.log('=== CR4-DHT node up ===')
console.log('peerId (STABLE across restarts): ' + node.peerId.toString())
console.log('known peers to reconnect to: ' + (known.length ? known.map((k) => k.slice(0, 12) + '…').join(', ') : '(none yet — pair on the same Wi-Fi first)'))
console.log('addresses:'); for (const ma of node.getMultiaddrs()) console.log('  ' + ma.toString())
console.log('\nStep 1: run on both machines on the SAME Wi-Fi → they pair (saved).')
console.log('Step 2: move to DIFFERENT networks, run again → DHT finds + dcutr punches a DIRECT link.')
console.log('\nType:  edit archery location "Field 1"  |  state  |  peers  |  known  |  quit')

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' })
rl.prompt()
rl.on('line', (line) => {
  const m = line.trim().match(/^edit\s+(\S+)\s+(name|location)\s+"?([^"]*)"?\s*$/)
  if (m) { const [, id, field, value] = m; doc = A.change(doc, (d) => { if (!d[id]) d[id] = {}; d[id][field] = value }); printState('▶ your edit'); broadcast() }
  else if (line.trim() === 'state') printState()
  else if (line.trim() === 'peers') console.log('  connected: ' + (node.getPeers().map((p) => p.toString().slice(0, 12) + '…').join(', ') || '(none)'))
  else if (line.trim() === 'known') console.log('  paired peers: ' + (known.map((k) => k.slice(0, 12) + '…').join(', ') || '(none)'))
  else if (line.trim() === 'quit' || line.trim() === 'exit') { node.stop().then(() => process.exit(0)); return }
  else if (line.trim()) console.log('  commands: edit <entity> <name|location> <value> | state | peers | known | quit')
  rl.prompt()
})
