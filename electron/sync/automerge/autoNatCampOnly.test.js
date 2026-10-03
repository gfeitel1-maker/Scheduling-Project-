// @vitest-environment node
//
// T336 chunk 1, Precondition 4 (docs/work/specs/2026-10-03-t336-holepunch-build-design.md §4,
// "the AutoNAT camp-peers-only test (T337 §C's design, now executed against this slice's actual
// implementation"): extend relayRoleCampOnly.test.js's real-multi-node pattern to prove a
// reachable NON-camp peer is NEVER usable as an AutoNAT server/probe target and never learns
// liveness — only camp-admitted peers can.
//
// ============================================================================================
// STOP — this precondition CANNOT be proven green against @libp2p/autonat@3.0.28 as installed.
// This is a genuine architectural blocker, found by reading the real installed package, not a
// guess, and not worked around below. Per the organizer's own instruction ("If you CANNOT prove
// this real-multi-node, STOP immediately and report — do NOT work around it; the organizer must
// be told"), this file stops at the RED proof and does not fabricate a GREEN.
//
// WHY: T337's relay camp-scoping (relayRoleCampOnly.test.js) works because @libp2p/circuit-relay-v2
// itself calls out to `components.connectionGater.denyInboundRelayReservation`/
// `denyOutboundRelayedConnection` — hooks that package DELIBERATELY exposes for exactly this
// purpose, which transport.js's `isPeerAdmittedForRelay` closure (reusing `authenticatedPeers`)
// plugs into. @libp2p/autonat@3.0.28 has NO equivalent hook. Read directly from the installed
// package (not training knowledge, per org-source-verification):
//   - node_modules/@libp2p/autonat/dist/src/index.d.ts — `AutoNATServiceInit` has no peer-list,
//     allow-list, or admission-callback field of any kind (protocolPrefix, timeout, startupDelay,
//     refreshInterval, maxInboundStreams, maxOutboundStreams, connectionThreshold, maxMessageSize
//     — nothing peer-identity-shaped).
//   - node_modules/@libp2p/autonat/dist/src/autonat.js — `start()` calls
//     `this.components.registrar.handle(this.protocol, handler, {...})` and
//     `this.components.registrar.register(this.protocol, { onConnect: ... })` directly; neither
//     call site, nor `handleIncomingAutonatStream`/`handleAutonatMessage` anywhere in the file,
//     ever reads `this.components.connectionGater`. `grep -c connectionGater` on that file is 0.
//   - `@libp2p/interface`'s `ConnectionGater` type (node_modules/@libp2p/interface/dist/src/
//     connection-gater.d.ts) exposes `denyDialPeer`, `denyDialMultiaddr`, `denyInboundConnection`,
//     `denyOutboundConnection`, `denyInbound/OutboundEncryptedConnection`,
//     `denyInbound/OutboundUpgradedConnection`, and the THREE relay-specific hooks T337 already
//     uses. There is no `denyInboundAutonatProbe`/`denyAutonatDial`-shaped hook — relay got one
//     because @libp2p/circuit-relay-v2 was built to call it; autonat (the deprecated v1 protocol;
//     the package's own header recommends `@libp2p/autonat-v2` instead) was not.
//   - The connection-wide hooks that DO exist (`denyInboundUpgradedConnection`/
//     `denyOutboundUpgradedConnection`) are not usable as a substitute: they gate the WHOLE
//     connection, before this app's own AUTH_PROTO handshake can run at all (transport.js's own
//     module comment: "any stranger on the LAN who opens a connection" stays connected pending
//     app-level authentication) — denying there would also block the not-yet-admitted peer from
//     ever being able to authenticate and become admitted in the first place.
// Net: the admission-closure-reuse pattern §2 of the design doc specifies (reuse T337's
// `authenticatedPeers` closure "the same way" the relay gater does) has NO wiring point to attach
// to in this package. AutoNAT is therefore NOT wired into transport.js/syncStarter.js in this
// chunk (see syncStarter.js's T336 comment) — wiring it unscoped would ship exactly the
// unbounded-population exposure shape this program exists to avoid; wiring a FAKE scope (e.g.
// gating the whole raw connection, which breaks admission) would misrepresent what was proven.
//
// WHAT THIS FILE PROVES INSTEAD: the hazard is real on a genuine two-node libp2p connection with
// zero admission relationship (not simulated, not asserted from reading docs alone) — a stranger's
// AutoNAT dial-back request is fully processed by the server's real protocol handler, with no
// permission/admission concept anywhere in the response path. Contrast directly with
// relayRoleCampOnly.test.js's `Status.PERMISSION_DENIED` for the identical "stranger, never
// admitted" shape — AutoNAT has no such status in its protocol (Message.ResponseStatus is OK /
// E_DIAL_ERROR / E_DIAL_REFUSED / E_BAD_REQUEST / E_INTERNAL_ERROR — all either success or a
// purely technical dial-mechanics outcome, never an admission refusal).
//
// Recommendation to the organizer: either (a) accept AutoNAT's dial-back probe as NOT built in
// this program (dcutr's own simultaneous-open punch does not require it — AutoNAT is advisory
// reachability-signaling, not load-bearing for the punch itself, which only ever runs over an
// already camp-admitted relayed connection per the design doc's §1), or (b) route a custom
// protocol-level wrapper (bypassing the package's own registrar.handle registration and gating the
// stream manually, the same way transport.js already does for PROTO/SYNC_PROTO) through an
// Architect review, since it is new wiring this doc did not scope and changes what "reuse, don't
// reinvent" means here. This file does not pick between those — that is the organizer's call.
import { describe, it, expect, afterEach } from 'vitest'
import { createLibp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { identify } from '@libp2p/identify'
import { autoNAT } from '@libp2p/autonat'
import { pbStream } from '@libp2p/utils'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Deep-import of the package's own protobuf codec — same technique relayRoleCampOnly.test.js uses
// for circuit-relay-v2, for the same reason (not part of the package's public `exports` map).
// org-source-verification: resolved against @libp2p/autonat@3.0.28, the version actually installed
// in this worktree (377c28f0) — read from node_modules, not assumed from training knowledge.
import { Message } from '../../../node_modules/@libp2p/autonat/dist/src/pb/index.js'

const AUTONAT_PROTOCOL = '/libp2p/autonat/1.0.0'

let nodes = []
afterEach(async () => {
  await Promise.all(nodes.map((n) => n.stop()))
  nodes = []
})

async function startNode(services = {}) {
  const node = await createLibp2p({
    addresses: { listen: ['/ip4/127.0.0.1/tcp/0'] },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: { identify: identify(), ...services },
  })
  nodes.push(node)
  return node
}

describe('T336 Precondition 4 — AutoNAT camp-peers-only (STOP: no admission hook exists to build GREEN against)', () => {
  // ── Structural proof — the absence is in the package's own source, not assumed ───────────
  it('STRUCTURAL: @libp2p/autonat@3.0.28 never reads components.connectionGater anywhere in its service', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const repoRoot = join(__dirname, '..', '..', '..')
    const autonatSrc = readFileSync(
      join(repoRoot, 'node_modules', '@libp2p', 'autonat', 'dist', 'src', 'autonat.js'),
      'utf8'
    )
    expect(autonatSrc.includes('connectionGater')).toBe(false)
  })

  it('STRUCTURAL: AutoNATServiceInit (the ONLY configuration surface this package exposes) has no peer/admission field', () => {
    const __dirname = dirname(fileURLToPath(import.meta.url))
    const repoRoot = join(__dirname, '..', '..', '..')
    const dts = readFileSync(
      join(repoRoot, 'node_modules', '@libp2p', 'autonat', 'dist', 'src', 'index.d.ts'),
      'utf8'
    )
    // Every field AutoNATServiceInit actually declares, confirmed present (so this isn't reading a
    // stale/wrong file) — and confirmed to contain nothing peer-identity-shaped.
    for (const knownField of ['protocolPrefix', 'timeout', 'startupDelay', 'refreshInterval', 'maxInboundStreams', 'maxOutboundStreams', 'connectionThreshold', 'maxMessageSize']) {
      expect(dts.includes(knownField)).toBe(true)
    }
    for (const admissionShapedField of ['allowedPeers', 'peerFilter', 'onlyAdmitted', 'admissionCallback', 'campScope']) {
      expect(dts.includes(admissionShapedField)).toBe(false)
    }
  })

  // ── Real multi-node RED — the hazard is genuine, not merely inferred from reading source ──
  it('RED (real two-node libp2p, no mocks): a NEVER-ADMITTED stranger\'s AutoNAT dial-back request is fully processed by the server — no permission/admission refusal exists in the response path', async () => {
    const server = await startNode({ autoNAT: autoNAT() })
    // `stranger` has NO relationship whatsoever to `server` beyond a raw TCP+Noise connection —
    // no authenticatedPeers entry, no camp, no T337 admission closure, nothing. This is the exact
    // "reachable NON-camp peer" shape Precondition 4 requires proving against.
    const stranger = await startNode()

    await stranger.dial(server.getMultiaddrs()[0])

    const stream = await stranger.dialProtocol(server.peerId, AUTONAT_PROTOCOL)
    const pbstr = pbStream(stream).pb(Message)
    await pbstr.write({
      type: Message.MessageType.DIAL,
      dial: {
        peer: {
          id: stranger.peerId.multihash.bytes,
          addrs: stranger.getMultiaddrs().map((ma) => ma.bytes),
        },
      },
    })
    const response = await pbstr.read()
    await stream.close().catch(() => {})

    // The response is a real, well-formed DIAL_RESPONSE — the server engaged fully with a total
    // stranger's request. It is NOT a permission/admission refusal, because the protocol has no
    // such status: it is either OK (dial succeeded) or a purely technical outcome (no dialable
    // address, bad request, etc). Loopback addresses are filtered as "private" by the package's
    // own dial-eligibility check (unrelated to camp admission), so E_DIAL_REFUSED is the expected
    // technical outcome here — the point is WHICH statuses are even possible, not which one fires.
    expect(response.type).toBe(Message.MessageType.DIAL_RESPONSE)
    expect(Object.values(Message.ResponseStatus)).not.toContain('PERMISSION_DENIED')
    expect([
      Message.ResponseStatus.OK,
      Message.ResponseStatus.E_DIAL_ERROR,
      Message.ResponseStatus.E_DIAL_REFUSED,
      Message.ResponseStatus.E_BAD_REQUEST,
      Message.ResponseStatus.E_INTERNAL_ERROR,
    ]).toContain(response.dialResponse.status)
  })

  // ── Contrast — the SAME "never admitted" shape DOES get refused for relay (T337), proving the
  // asymmetry is real and not an artifact of this test's own construction ──────────────────────
  it('CONTRAST: the identical never-admitted-stranger shape against T337\'s relay IS refused (PERMISSION_DENIED) — proving AutoNAT is the odd one out, not every capability', async () => {
    // This asserts against relayRoleCampOnly.test.js's own already-proven claim rather than
    // re-deriving it — see that file for the full real-node proof. Restated here only as the
    // comparison point: that capability has a refusal status; this one, read above, structurally
    // cannot.
    const { Status } = await import('../../../node_modules/@libp2p/circuit-relay-v2/dist/src/pb/index.js')
    expect(Object.values(Status)).toContain(Status.PERMISSION_DENIED)
    expect(Object.values(Message.ResponseStatus)).not.toContain(Status.PERMISSION_DENIED)
  })
})
