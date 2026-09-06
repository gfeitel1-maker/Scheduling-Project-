// CR2 — two real libp2p nodes exchange Automerge document state over an
// encrypted libp2p stream and converge. Proves the TRANSPORT half of the route
// (the data/merge half was proven in test-automerge.mjs).
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { pipe } from 'it-pipe'
import { encode, decode } from 'it-length-prefixed'
import * as A from '@automerge/automerge'
// libp2p v2 stream API: it-pipe duplex (stream.sink / stream.source), length-prefixed framing.

const PROTO = '/shoresh/automerge/1.0.0'
let pass = 0, fail = 0
const check = (n, c, d) => { if (c) { pass++; console.log('  ✅ ' + n) } else { fail++; console.log('  ❌ ' + n + (d ? '  -> ' + d : '')) } }

async function makeNode () {
  return await createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify() },
  })
}

// A peer merges any Automerge snapshot it receives on this protocol into its doc.
// libp2p v3 MessageStream is event-based: 'message' events carry bytes; the remote
// half-closing write signals the message is complete.
function installHandler (node, getDoc, setDoc, label) {
  return node.handle(PROTO, ({ stream }) => {
    pipe(stream.source, (s) => decode(s), async (source) => {
      for await (const framed of source) {
        setDoc(A.merge(getDoc(), A.load(framed.subarray())))
        console.log('  [' + label + '] merged a doc received over libp2p')
      }
    }).catch((e) => console.error(label, 'handler error:', e.message))
  })
}

async function sendDoc (fromNode, toPeerId, doc) {
  const stream = await fromNode.dialProtocol(toPeerId, PROTO)
  await pipe([A.save(doc)], (s) => encode(s), stream.sink)
}

// --- shared base so both peers share ancestry (clean merges) -----------------
const baseBytes = A.save(A.from({
  archery: { name: 'Archery', location: 'unassigned' },
  pottery: { name: 'Pottery', location: 'unassigned' },
}))
let docA = A.load(baseBytes)
let docB = A.load(baseBytes)

const nodeA = await makeNode()
const nodeB = await makeNode()
await installHandler(nodeA, () => docA, (d) => (docA = d), 'A')
await installHandler(nodeB, () => docB, (d) => (docB = d), 'B')

// connect B -> A over real TCP + noise + yamux
await nodeB.dial(nodeA.getMultiaddrs()[0])
await new Promise((r) => setTimeout(r, 300)) // let identify settle
check('libp2p connection established (encrypted, muxed)', nodeB.getConnections().length > 0)
console.log('  peerA=' + nodeA.peerId.toString().slice(0, 16) + '…  peerB=' + nodeB.peerId.toString().slice(0, 16) + '…')

// A edits and pushes; B edits and pushes
docA = A.change(docA, (d) => { d.archery.location = 'Field 1' })
await sendDoc(nodeA, nodeB.peerId, docA)
docB = A.change(docB, (d) => { d.pottery.location = 'Kiln' })
await sendDoc(nodeB, nodeA.peerId, docB)
await new Promise((r) => setTimeout(r, 600)) // let both handlers finish merging

check('B has A\'s edit (Archery @ Field 1)', docB.archery.location === 'Field 1', docB.archery.location)
check('A has B\'s edit (Pottery @ Kiln)', docA.pottery.location === 'Kiln', docA.pottery.location)
check('A & B CONVERGED (identical state over libp2p)',
  JSON.stringify(docA) === JSON.stringify(docB),
  '\n     A=' + JSON.stringify(docA) + '\n     B=' + JSON.stringify(docB))

await nodeA.stop(); await nodeB.stop()
console.log('\n' + '='.repeat(56))
console.log('RESULT: ' + pass + ' passed, ' + fail + ' failed')
console.log('Two real libp2p peers exchanged Automerge state over an encrypted')
console.log('stream and converged. Transport half proven (LAN/localhost).')
console.log('='.repeat(56))
process.exit(fail === 0 ? 0 : 1)
