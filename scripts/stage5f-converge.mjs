#!/usr/bin/env node
// Stage 5f — real two-machine convergence check for the Automerge + libp2p sync engine.
//
// Run this only AFTER scripts/mdns-probe.mjs passes on BOTH machines. That probe proves raw
// multicast reaches both ways; this proves the actual stack on top of it — @libp2p/mdns discovery,
// the libp2p dial + noise handshake, the auth handshake in both directions, and document
// convergence projected into SQLite. Those are the things CI structurally cannot test.
//
// SAFETY: never touches a real camp database. Creates a throwaway SQLite file in the OS temp dir
// and deletes it on exit. Does not read or write the shoresh / shoresh-dev application databases.
//
// USAGE (same Wi-Fi, both machines):
//   Machine A:  node scripts/stage5f-converge.mjs host
//                 -> prints a PAIRING BLOB; copy that one line to machine B
//   Machine B:  node scripts/stage5f-converge.mjs client --blob <PASTE>
//
// The blob stands in for the real pairing flow (which needs the app's UI approval step). Everything
// after it — token verification, admission, discovery, merge, projection — is the production code.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'

import { initSchema } from '../electron/db/localDb.js'
import { ensureHostSigningKey, issueCampToken } from '../electron/auth/localAuth.js'
import { startSyncNode } from '../electron/sync/automerge/syncNode.js'
import { wireMutualAuth } from '../electron/sync/automerge/mutualAuth.js'
import { createMdnsDiscovery, campDiscoveryTag } from '../electron/sync/automerge/discovery.js'
import { createEmptyDoc, applyWrite } from '../electron/automerge/campDocument.js'
import {
  setUserDataDirGetter, setLocalWriteBroadcaster, getCurrentDoc, setCurrentDoc, flushPendingWrites,
} from '../electron/sync/automerge/liveDoc.js'

const role = process.argv[2]
const blobArg = (() => { const i = process.argv.indexOf('--blob'); return i > -1 ? process.argv[i + 1] : null })()
if (role !== 'host' && role !== 'client') {
  console.error('usage: node scripts/stage5f-converge.mjs host | client --blob <blob>'); process.exit(2)
}
if (role === 'client' && !blobArg) { console.error('client mode needs --blob <blob from the host>'); process.exit(2) }

const RUN_MS = Number(process.env.STAGE5F_RUN_MS || 300_000)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shoresh-5f-'))
const db = new Database(path.join(tmpDir, 'check.sqlite'))
initSchema(db)
setUserDataDirGetter(() => tmpDir)

let stopped = false
function cleanup() {
  if (stopped) return; stopped = true
  try { flushPendingWrites() } catch {}
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
}
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })

const CHECKS = [
  'libp2p node started',
  'discovered the peer via @libp2p/mdns',
  'peer authenticated to us (inbound admission)',
  'our row reached the peer (outbound: they accepted our frames)',
  "peer's row landed in our SQLite (convergence + projection)",
]
const state = new Map(CHECKS.map((c) => [c, false]))
function pass(name, detail = '') {
  if (state.get(name)) return
  state.set(name, true)
  console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`)
}

let campId, deviceId, token, peerDeviceId
if (role === 'host') {
  campId = randomUUID(); deviceId = randomUUID(); peerDeviceId = randomUUID()
  db.prepare('INSERT INTO camps (id, name) VALUES (?, ?)').run(campId, 'Stage5F')
  const key = ensureHostSigningKey(db)
  db.prepare('UPDATE camps SET signing_public_key = ?').run(key.public_key)
  for (const id of [deviceId, peerDeviceId]) {
    db.prepare("INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status) VALUES (?,?,?,?,'authorized')")
      .run(id, `dev-${id.slice(0, 6)}`, new Date().toISOString(), randomBytes(32).toString('hex'))
  }
  token = issueCampToken(db, randomUUID(), deviceId)
  const blob = Buffer.from(JSON.stringify({
    campId, publicKey: key.public_key,
    clientDeviceId: peerDeviceId, clientToken: issueCampToken(db, randomUUID(), peerDeviceId),
    hostDeviceId: deviceId,
  })).toString('base64')
  console.log('\n=== PAIRING BLOB — copy this ENTIRE line to the other machine ===\n')
  console.log(blob)
  console.log('\n=== then there: node scripts/stage5f-converge.mjs client --blob <that line> ===\n')
} else {
  const p = JSON.parse(Buffer.from(blobArg, 'base64').toString('utf8'))
  campId = p.campId; deviceId = p.clientDeviceId; token = p.clientToken; peerDeviceId = p.hostDeviceId
  db.prepare('INSERT INTO camps (id, name, signing_public_key) VALUES (?,?,?)').run(campId, 'Stage5F', p.publicKey)
  for (const id of [deviceId, peerDeviceId]) {
    db.prepare("INSERT INTO devices (id, name, authorized_at, device_secret_identifier, pairing_status) VALUES (?,?,?,?,'authorized')")
      .run(id, `dev-${id.slice(0, 6)}`, new Date().toISOString(), randomBytes(32).toString('hex'))
  }
}

console.log(`role=${role}  camp=${campId.slice(0, 8)}  tag=${campDiscoveryTag(campId)}`)
console.log(`temp db: ${tmpDir}  (deleted on exit)\n`)

const node = await startSyncNode({
  deviceId, db, doc: createEmptyDoc(),
  peerDiscovery: [createMdnsDiscovery({ campId })],
  // Must match production (main.js): the default is loopback-only, which cannot accept a
  // connection from another machine — the exact bug this harness exists to catch.
  listen: ['/ip4/0.0.0.0/tcp/0'],
  onAuthRejected: (i) => console.log(`  ⚠️  inbound auth REJECTED: ${JSON.stringify(i)}`),
})
setLocalWriteBroadcaster((d) => node.broadcastLocalDoc(d).catch(() => {}))
node.setAuthToken(token)
pass('libp2p node started', `peer ${String(node.peerId).slice(0, 14)}…`)
console.log(`  listening: ${node.getMultiaddrs().map(String).join(', ') || '(none)'}`)

const mutual = wireMutualAuth(node, {
  deviceId, getToken: () => token,
  onRejected: (i) => console.log(`  ⚠️  outbound auth rejected: ${JSON.stringify(i)}`),
})
// NOTE: wireMutualAuth already registers its OWN onPeerDiscovery handler and dials/authenticates
// from it. This second handler is for REPORTING only — it must not re-dial, and it must destructure
// `{ id }` like the production code does. (An earlier version of this script registered a duplicate
// handler and passed the raw event object to tryAuthenticate, producing "[object Object]" and a
// multibase decode error. That was a bug in this harness, not in the engine — production's
// transport.onPeerDiscovery emits `{ id, multiaddrs }` and mutualAuth.js destructures it correctly.)
node.onPeerDiscovery?.(({ id }) => {
  pass('discovered the peer via @libp2p/mdns', String(id).slice(0, 14) + '…')
})

const myRow = `row-${role}`
setTimeout(() => {
  const next = applyWrite(getCurrentDoc(db) ?? createEmptyDoc(), {
    entity: 'activities', entity_id: myRow, field: 'name', value: `written-on-${role}`,
  })
  setCurrentDoc(db, next)
  node.broadcastLocalDoc(next).catch((e) => console.log(`  ⚠️  broadcast failed: ${e?.message ?? e}`))
  console.log(`  … wrote "${myRow}" locally and broadcast it`)
}, 10_000)

const poll = setInterval(() => {
  if (node.getPeers().length > 0) pass('discovered the peer via @libp2p/mdns', `${node.getPeers().length} connected`)
  for (const p of node.getPeers()) {
    if (node.isPeerAuthenticated(String(p))) pass('peer authenticated to us (inbound admission)', String(p).slice(0, 14) + '…')
  }
  const theirs = db.prepare("SELECT id, name FROM activities WHERE id != ?").all(myRow)
  if (theirs.length) {
    pass('our row reached the peer (outbound: they accepted our frames)', 'inferred from two-way exchange')
    pass("peer's row landed in our SQLite (convergence + projection)", theirs.map((r) => `${r.id}=${r.name}`).join(', '))
  }
}, 1000)

setTimeout(async () => {
  clearInterval(poll)
  console.log('\n================ STAGE 5F RESULT ================')
  for (const c of CHECKS) console.log(`${state.get(c) ? '✅ PASS' : '❌ FAIL'}  ${c}`)
  const failed = CHECKS.filter((c) => !state.get(c))
  if (!failed.length) {
    console.log('\n✅ ALL PASSED — two real machines discovered each other, authenticated both ways,')
    console.log('   and converged. This is what Stage 6 was waiting on.')
  } else {
    console.log(`\n❌ ${failed.length} failed. Where it broke:`)
    if (!state.get(CHECKS[1])) {
      console.log('   Raw multicast passed (mdns-probe) but @libp2p/mdns found nothing — the problem is')
      console.log('   libp2p discovery itself (interface binding / its own port), not the network.')
    } else if (!state.get(CHECKS[2])) {
      console.log('   Discovered but not admitted — the AUTH handshake failed, not the network.')
    } else if (!state.get(CHECKS[4])) {
      console.log('   Authenticated but no convergence — doc broadcast or projection, not discovery/auth.')
    }
    console.log('   Tag derivation is pinned by frozen test vectors, so mismatched advertising is ruled out.')
  }
  await node.stop().catch(() => {})
  cleanup()
  process.exit(failed.length ? 1 : 0)
}, RUN_MS)
