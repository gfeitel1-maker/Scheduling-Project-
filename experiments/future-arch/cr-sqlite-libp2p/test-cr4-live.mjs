// Validates the CR4 LIVE-SYNC logic (the handler + broadcast + edit path used by
// cr4-node.mjs) between two in-process libp2p nodes — no stdout parsing, so it can
// run headlessly. mDNS/--dial in cr4-node are just the discovery wrappers on top.
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { pipe } from 'it-pipe'
import { encode, decode } from 'it-length-prefixed'
import * as A from '@automerge/automerge'

const PROTO = '/shoresh/automerge/1.0.0'
const GENESIS = 'hW9Kg6gGAWAApQEBEOwZNyQ3rioMV7TtzKM2k3UBvwdao2opxw1SeNXssZYVNrKJ5gNMtp5NZmnr/bhYnPgGAQIDAhMCIwZAAlYCDAEEAgQRBBMHFQghAiMCNAJCBFYEVw+AAQJ/AH8BfxB/udHy1AZ/AH8HAAEPAAABDwEAAg4AAAF+AAINAX8EY2FtcAAPEAAQAQEPfwQPAX8ADxZDYW1wIEFjaHZhIDIwMjcQAAA='
let pass = 0, fail = 0
const check = (n, c, d) => { if (c) { pass++; console.log('  ✅ ' + n) } else { fail++; console.log('  ❌ ' + n + (d ? '  -> ' + d : '')) } }

function makeNode () {
  return createLibp2p({ addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] }, transports: [tcp()],
    connectionEncrypters: [noise()], streamMuxers: [yamux()], services: { identify: identify() } })
}
// Each peer keeps a doc; the CR4 handler/broadcast are attached to a peer object.
function attach (node) {
  const peer = { node, doc: A.clone(A.load(new Uint8Array(Buffer.from(GENESIS, 'base64')))) }
  node.handle(PROTO, ({ stream, connection }) => {
    pipe(stream.source, (s) => decode(s), async (source) => {
      for await (const framed of source) {
        const before = A.getHeads(peer.doc)
        peer.doc = A.merge(peer.doc, A.load(framed.subarray()))
        if (JSON.stringify(A.getHeads(peer.doc)) !== JSON.stringify(before)) peer.broadcast(connection.remotePeer)
      }
    }).catch(() => {})
  })
  peer.sendTo = async (pid) => { try { const s = await node.dialProtocol(pid, PROTO); await pipe([A.save(peer.doc)], (x) => encode(x), s.sink) } catch {} }
  peer.broadcast = (except) => { for (const p of node.getPeers()) { if (!except || p.toString() !== except.toString()) peer.sendTo(p) } }
  peer.edit = (id, field, value) => { peer.doc = A.change(peer.doc, (d) => { if (!d[id]) d[id] = {}; d[id][field] = value }); peer.broadcast() }
  return peer
}

const A1 = attach(await makeNode())
const B1 = attach(await makeNode())
await B1.node.dial(A1.node.getMultiaddrs()[0]) // connect (in-process multiaddr object)
await new Promise((r) => setTimeout(r, 300))
check('two nodes connected', B1.node.getPeers().length > 0)

// A edits -> should reach B
A1.edit('archery', 'location', 'Field 1')
await new Promise((r) => setTimeout(r, 400))
check('B received A\'s live edit (Archery @ Field 1)', B1.doc.archery?.location === 'Field 1', B1.doc.archery?.location)

// B edits -> should reach A
B1.edit('pottery', 'location', 'Kiln')
await new Promise((r) => setTimeout(r, 400))
check('A received B\'s live edit (Pottery @ Kiln)', A1.doc.pottery?.location === 'Kiln', A1.doc.pottery?.location)

check('both converged (identical state)',
  JSON.stringify(A1.doc) === JSON.stringify(B1.doc))

// concurrent same-slot edit surfaces a conflict on both after they exchange
A1.edit('archery', 'location', 'Lake')
B1.edit('archery', 'location', 'Gym')
await new Promise((r) => setTimeout(r, 600))
const cA = A.getConflicts(A1.doc.archery, 'location')
check('same-slot conflict is surfaceable on A (getConflicts)', cA && Object.keys(cA).length >= 2)
check('A & B still converge after the conflict', JSON.stringify(A1.doc) === JSON.stringify(B1.doc))

await A1.node.stop(); await B1.node.stop()
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed  (CR4 live-sync logic)')
process.exit(fail === 0 ? 0 : 1)
