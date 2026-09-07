#!/usr/bin/env node
// Stage 5f pre-check — can these two machines exchange mDNS multicast AT ALL?
//
// No npm install, no dependencies, no database, nothing touched on disk. Pure node:dgram against
// the real mDNS group (224.0.0.251:5353) — the same group @libp2p/mdns uses — so a firewall or an
// access point that blocks device-to-device multicast fails here exactly as it would fail the app.
//
// WHY THIS FIRST: the Automerge/libp2p path needs discovery in BOTH directions (a node only sends
// doc bytes to peers that authenticated to it), whereas the legacy WebSocket path only needs the
// Client to find the Host. So a network can run the current app fine and silently break the new
// one. This 2-minute check answers that before anyone installs anything.
//
// RUN ON BOTH MACHINES AT THE SAME TIME (any order, within ~30s of each other):
//   node scripts/mdns-probe.mjs <a-label-for-this-machine>
// e.g.  node scripts/mdns-probe.mjs mac      /      node scripts/mdns-probe.mjs dell
//
// Each machine announces itself once a second and prints what it hears. Success = each machine
// sees the OTHER one's label. Runs 45s then prints a verdict.
import dgram from 'node:dgram'
import os from 'node:os'

const LABEL = process.argv[2] || os.hostname()
const GROUP = '224.0.0.251'
const PORT = 5353
const MAGIC = 'SHORESH5F|'
const RUN_MS = 45_000

const seen = new Set()
const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })

sock.on('error', (err) => {
  console.error(`\n❌ socket error: ${err.message}`)
  if (String(err.code) === 'EACCES') console.error('   Try again with sudo, or pick a machine where port 5353 is bindable.')
  process.exit(1)
})

sock.on('message', (msg, rinfo) => {
  const s = msg.toString('utf8')
  if (!s.startsWith(MAGIC)) return               // ignore ordinary mDNS chatter
  const who = s.slice(MAGIC.length).trim()
  if (who === LABEL) return                      // our own echo
  if (!seen.has(who)) {
    seen.add(who)
    console.log(`  ✅ HEARD "${who}" from ${rinfo.address}`)
  }
})

sock.bind(PORT, () => {
  try {
    sock.addMembership(GROUP)
  } catch (err) {
    console.error(`❌ could not join multicast group: ${err.message}`)
    process.exit(1)
  }
  sock.setMulticastTTL(255)
  try { sock.setMulticastLoopback(true) } catch { /* not fatal */ }

  console.log(`\nmDNS multicast probe — this machine is "${LABEL}"`)
  const addrs = Object.entries(os.networkInterfaces())
    .flatMap(([name, list]) => (list || []).filter((i) => i.family === 'IPv4' && !i.internal).map((i) => `${name}=${i.address}`))
  console.log(`local IPv4: ${addrs.join(', ') || '(none found)'}`)
  console.log(`listening on ${GROUP}:${PORT}, announcing once a second for ${RUN_MS / 1000}s`)
  console.log(`\nRun this on the OTHER machine too, with a different label.\n`)

  const beat = setInterval(() => {
    const buf = Buffer.from(`${MAGIC}${LABEL}`)
    sock.send(buf, 0, buf.length, PORT, GROUP, (err) => {
      if (err) console.error(`  ⚠️  send failed: ${err.message}`)
    })
  }, 1000)

  setTimeout(() => {
    clearInterval(beat)
    console.log('\n================ RESULT ================')
    if (seen.size > 0) {
      console.log(`✅ PASS — heard: ${[...seen].join(', ')}`)
      console.log('   Multicast reaches this machine. If BOTH machines printed PASS, bidirectional')
      console.log('   mDNS works on this network and Stage 5f can proceed to the real convergence test.')
      console.log('   If only ONE side passed, discovery is one-way — the legacy WebSocket path would')
      console.log('   still work here, but the Automerge/libp2p path would silently never sync.')
    } else {
      console.log('❌ FAIL — heard nothing from another machine.')
      console.log('   Likely causes, in order:')
      console.log('     1. The other probe was not running at the same time (most common — just retry).')
      console.log('     2. AP/router client isolation (very common on guest, hotel, and JCC Wi-Fi).')
      console.log('     3. Host firewall blocking UDP 5353 (Windows Defender prompts on first run —')
      console.log('        if you saw a prompt and clicked Cancel, that is this).')
      console.log('     4. The two machines are on different SSIDs/VLANs or one is on cellular.')
      console.log('   This is exactly the condition that would make the new sync engine fail silently.')
    }
    sock.close()
    process.exit(seen.size > 0 ? 0 : 1)
  }, RUN_MS)
})
