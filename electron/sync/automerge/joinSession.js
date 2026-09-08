// How a brand-new device joins a camp over libp2p.
// Design + rationale: docs/adr/2026-09-08-libp2p-join-flow.md.
//
// WHY A SEPARATE MODULE. Every other path in this directory assumes the device
// already knows its camp: `startAutomergeSyncNodeIfEnabled` (main.js) returns
// early with no `camps` row, and `createMdnsDiscovery` scopes mDNS by
// `campDiscoveryTag(campId)`. A joining device has neither. Rather than
// loosening those two — both of which are correct for every device that HAS
// paired, and one of which is a privacy guarantee — this module owns the
// short-lived, pre-identity phase and hands off the moment identity exists.
//
// THE HANDOFF IS THE POINT. A join session is over as soon as the device has a
// camps row and the first document has landed. From that instant it is an ordinary
// Client: main.js's normal startup path starts a camp-scoped node next launch,
// and nothing here is ever consulted again. Nothing in this file is a parallel
// implementation of sync — it is the on-ramp.
//
// WHAT IS DELIBERATELY NOT HERE. No new wire messages: pairing_request and
// login are the frames authGate.js already implements and pairingLogin.test.js
// already pins, sent over the same /shoresh/auth/1.0.0 protocol the WS
// transport's equivalents mirror. The one thing this slice added to authGate is
// the RECEIVING side of the Host's approval dial-back, which previously landed
// on `unsupported_auth_message` — see that branch's comment.
import * as A from '@automerge/automerge'

import { createEmptyDoc } from '../../automerge/campDocument.js'
import { joinDiscoveryTag, normalizeJoinCode, newJoinNonce, joinProof, verifyJoinProof } from '../joinCode.js'
import { createMdnsDiscovery } from './discovery.js'
import { startSyncNode } from './syncNode.js'

// How long to wait for the document after a successful login before telling the
// director it did not arrive.
//
// This bound exists because of the failure mode the ADR calls out as the one
// most likely to be got wrong: under the op-log, identity arrived in a single
// `full_sync` message, so "logged in" and "has a camp" were the same instant.
// Under a CRDT they are two, and the gap between them is a real state a device
// can get stuck in — approved, authenticated, and receiving nothing. A spinner
// that hides that is worse than an error that names it (Constitution Article V:
// the engine surfaces problems, it never quietly absorbs them). 30s is chosen
// to be far longer than a LAN sync exchange plausibly takes while still being
// inside the time a person will stand and watch.
export const DOCUMENT_WAIT_MS = 30_000

// How long to wait for mDNS to surface a Host advertising the join tag. mDNS
// announces are periodic, so this covers "the director opened Add-a-device a
// moment after the joiner typed the code", not just an instant answer.
export const DISCOVERY_WAIT_MS = 20_000

const LISTEN_ALL_INTERFACES = ['/ip4/0.0.0.0/tcp/0']

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

function withTimeout(promise, ms, timeoutValue, { setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {}) {
  let timer
  return Promise.race([
    promise.then((v) => { clearTimeoutFn(timer); return v }),
    new Promise((resolve) => { timer = setTimeoutFn(() => resolve(timeoutValue), ms) }),
  ])
}

function campRow(db) {
  return db.prepare('SELECT id, name FROM camps LIMIT 1').get() ?? null
}

/**
 * Starts the pre-identity libp2p node for a joining device.
 *
 * Returns `{ status: 'invalid_code' }` for anything that is not a join code —
 * a real typo must be reported as a typo, never turned into a discovery tag
 * that matches nothing and surfaces to the director as "no camps found", which
 * would send them to check their Wi-Fi over a mistyped character.
 *
 * Otherwise returns `{ status: 'started', session }`. The caller drives the
 * session: `findHost()` -> `requestPairing()` -> (director approves) ->
 * `login()` -> `waitForCamp()`, and `stop()` at any point. Each step is
 * separately awaitable because each maps to a distinct thing a person is
 * looking at on screen.
 *
 * `db` must be this device's own (camp-less) SQLite handle. This module writes
 * exactly ONE row to it — the `camps` singleton, from the authenticated login
 * reply, because `PROJECTIONS.camps.ensureExists` refuses to create it (see
 * login() below). Everything else, `users` included, arrives by ordinary
 * document projection.
 */
export async function startJoinSession({
  db,
  deviceId,
  deviceName,
  code,
  // Injected for tests, which dial over loopback and must not depend on a real
  // network interface — the same seam every other module in this directory uses
  // (see discovery.js's own note on why mDNS is not in transport.js's defaults).
  peerDiscovery,
  // For a caller that already knows the Host's PeerId and so has nothing to
  // discover. The integration harness is the one such caller today: it runs
  // both nodes in-process over loopback, where mDNS is unavailable — which is
  // precisely why discovery.js is deliberately kept out of transport.js's
  // defaults (see that module's note). Setting this skips discovery only; the
  // pairing, login, and document-arrival steps below are identical, so a test
  // using it is testing the real flow, not a shortcut around it.
  // Accepts either a PeerId or a full multiaddr ending in `/p2p/<PeerId>`; a
  // multiaddr is what an in-process caller actually has, and is also what
  // findHost() needs to dial when nothing announced an address for us.
  knownHost,
  listen = LISTEN_ALL_INTERFACES,
  startNode = startSyncNode,
  discoveryWaitMs = DISCOVERY_WAIT_MS,
  documentWaitMs = DOCUMENT_WAIT_MS,
} = {}) {
  const normalizedCode = normalizeJoinCode(code)
  if (normalizedCode === null) return { status: 'invalid_code' }
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    throw new Error('startJoinSession requires a deviceId')
  }

  // A device that already has a camp must never enter this flow — it would be
  // starting an unscoped node alongside its real one, and (worse) a document
  // received here would project over a camp that already exists. Refused
  // rather than guarded downstream, because there is no correct way to
  // continue.
  if (campRow(db)) {
    throw new Error('startJoinSession: this device already belongs to a camp')
  }

  // One nonce per join attempt, so a Host's reply can never be replayed against
  // a different attempt.
  const nonce = newJoinNonce()
  // Set once the Host has proved it holds the code. Everything that matters —
  // sending the PIN, writing the camps row, admitting the peer — is gated on
  // this, because the mDNS tag the Host was found by is public (see
  // joinCode.js's proof section for the mirrored-tag attack this closes).
  let hostProvedCode = false

  const firstPeer = deferred()
  const pairingDecision = deferred()
  const campArrived = deferred()

  const knownHostStr = knownHost == null ? null : String(knownHost)
  // `/ip4/…/tcp/…/p2p/<PeerId>` -> `<PeerId>`; a bare PeerId passes through.
  // The ADDRESS to dial keeps its original form (transport.dial's toDialTarget
  // parses a string as a PeerId, so a Multiaddr must stay a Multiaddr).
  const knownHostAddr = knownHostStr !== null && knownHostStr.includes('/p2p/') ? knownHost : null
  let hostPeerId = knownHostStr === null ? null : knownHostStr.split('/p2p/').pop()
  if (hostPeerId !== null) firstPeer.resolve(hostPeerId)

  const node = await startNode({
    deviceId,
    db,
    // The SHARED genesis, never a locally invented document (Stage 5 finding
    // 2: independently created documents have unrelated roots, and merging
    // them silently discards one side's entire entity collection — visible
    // only through getConflicts, which nothing reads). createEmptyDoc returns
    // the frozen GENESIS; this is the single most important line in the file.
    doc: A.clone(createEmptyDoc()),
    listen,
    peerDiscovery: peerDiscovery ?? [createMdnsDiscovery({ serviceTag: joinDiscoveryTag(normalizedCode) })],
    onPairingDecision: (msg, { fromPeerId }) => {
      // Only ever act on a decision from the Host we actually asked. An
      // unsolicited frame from any other peer is dropped here, on identity —
      // this is the check the authGate branch's comment defers to.
      if (fromPeerId !== hostPeerId) return
      if (msg.type === 'pairing_approved' && !checkHostProof(msg)) {
        pairingDecision.resolve({ type: 'pairing_denied', reason: 'bad_join_proof' })
        return
      }
      pairingDecision.resolve(msg)
    },
    onProjected: () => {
      const camp = campRow(db)
      if (camp) campArrived.resolve(camp)
    },
  })

  node.onPeerDiscovery(({ id }) => {
    // mDNS only ever surfaces peers advertising the join tag we asked for, so
    // the first peer seen IS this camp's Host (discovery.js's module comment
    // establishes that structurally). Keep the first: a re-announce from the
    // same Host must not reset a session already past pairing.
    if (hostPeerId === null) {
      hostPeerId = String(id)
      firstPeer.resolve(hostPeerId)
    }
  })

  // Records the Host's half of the proof, and refuses to advance without it.
  // Returns false for a peer that answered but could not prove it holds the
  // code — a mirrored-tag impostor — which is treated exactly like a denial.
  function checkHostProof(msg) {
    if (verifyJoinProof(normalizedCode, nonce, 'host', msg?.join_confirm)) {
      hostProvedCode = true
      return true
    }
    return false
  }

  const session = {
    node,
    code: normalizedCode,
    get hostPeerId() { return hostPeerId },

    /** Waits for a Host advertising this code. `null` means nobody answered —
     * the director's Add-a-device window is closed, they are on a different
     * network, or the code is for a camp that is not here. */
    async findHost() {
      const found = await withTimeout(firstPeer.promise, discoveryWaitMs, null)
      if (found === null) return null
      // A libp2p connection is bidirectional and the Host may already have
      // dialed us; dial only if we are not already connected (Stage 5 finding
      // 5 — requiring the dial to succeed killed sync against a firewalled
      // peer that could dial out but never accept).
      const connected = () => (node.getPeers?.() ?? []).some((p) => String(p) === found)
      if (!connected()) {
        try {
          await node.dial(knownHostAddr ?? found)
        } catch (err) {
          if (!connected()) throw err
        }
      }
      return found
    },

    /** Asks the Host to let this device in. `pending` means a human now has to
     * decide; `approved` is the idempotent re-delivery case for a device that
     * was already approved before (a retry, or a reinstall). */
    async requestPairing() {
      if (hostPeerId === null) throw new Error('requestPairing: no host found yet')
      const reply = await node.authenticateWith(hostPeerId, {
        type: 'pairing_request',
        device_id: deviceId,
        device_name: deviceName || `Device ${deviceId.slice(0, 8)}`,
        // Our half of the code proof. A peer that merely mirrored the public
        // mDNS tag cannot produce it, so it never reaches the director.
        join_nonce: nonce,
        join_proof: joinProof(normalizedCode, nonce, 'joiner'),
      })
      // The Host's half. Checked on BOTH pairing replies, because either can be
      // the last thing we hear before we would otherwise send a PIN.
      if (reply?.type === 'pairing_approved' || reply?.type === 'pairing_pending') {
        if (!checkHostProof(reply)) return { status: 'wrong_camp' }
      }
      if (reply?.type === 'pairing_approved') {
        return { status: 'approved', deviceSecretIdentifier: reply.device_secret_identifier }
      }
      if (reply?.type === 'pairing_denied') return { status: 'denied' }
      return { status: 'pending' }
    },

    /** Resolves when the director approves or denies, on the Host's dial-back.
     * No timeout by design: this is a human deciding, and there is no bound on
     * how long someone takes to walk to the office computer. The caller ends
     * the wait by calling stop() when the director abandons the screen. */
    async waitForPairingDecision() {
      const msg = await pairingDecision.promise
      return msg.type === 'pairing_approved'
        ? { status: 'approved', deviceSecretIdentifier: msg.device_secret_identifier }
        : { status: 'denied' }
    },

    /** PIN sign-in against the HOST's user table — the same `attemptLogin`
     * (scrypt, timing-safe compare, 5-attempt lockout) the WS path uses, via
     * connectionAuth.js's shared evaluateLogin. A wrong PIN here is wrong in
     * exactly the way it is wrong everywhere else, including the lockout. */
    async login({ name, pin, deviceSecretIdentifier }) {
      if (hostPeerId === null) throw new Error('login: no host found yet')
      // The PIN is the thing an impostor most wants, and it is the first
      // secret this flow would hand over. Never send it to a peer that has not
      // proved it holds the director's code.
      if (!hostProvedCode) {
        throw new Error('login: the host has not proved it holds this camp\'s join code')
      }
      const reply = await node.authenticateWith(hostPeerId, {
        type: 'login',
        device_id: deviceId,
        device_secret_identifier: deviceSecretIdentifier,
        name,
        pin,
      })
      if (reply?.type !== 'login_ok') {
        return { status: 'failed', locked: Boolean(reply?.locked), retryAfterMs: reply?.retryAfterMs }
      }
      // Hand the token to the node so its ordinary mutual-auth path can run.
      // Then authenticate immediately rather than waiting for mDNS to
      // re-announce this Host: wireMutualAuth leaves a peer un-dialed while
      // there is no token, and the next announce could be tens of seconds
      // away — which the director would experience as the join hanging after
      // a successful sign-in.
      node.setAuthToken(reply.token)
      await node.authenticateWith(hostPeerId, {
        type: 'authenticate',
        token: reply.token,
        device_id: deviceId,
      })
      // ADOPT THE CAMP. This is the libp2p-native replacement for the op-log's
      // first-pairing `full_sync`, which projector.js's own comment names as
      // "Stage 6's problem":
      //
      //   "this projection path structurally can never be how a device gets
      //    its FIRST camps row ... PROJECTIONS.camps.ensureExists only ever
      //    matches or refuses, never creates"
      //
      // So modeling `camps` (#325) converges a camp's NAME across devices that
      // already have the row; it cannot mint the row. It must be written here,
      // from the authenticated login reply, and it must be written BEFORE any
      // document projection runs — `users.camp_id` is an FK to `camps.id`, so
      // every user (and with them this device's ability to sign in again next
      // launch) would be rejected without it.
      //
      // Ordered BEFORE admitPeer deliberately: admission is what starts the
      // sync exchange, and a document that projected while this row was still
      // missing would drop `users` on an FK error and might be the only merge
      // this device ever receives.
      if (reply.camp?.id) {
        db.prepare(
          'INSERT OR REPLACE INTO camps (id, name, signing_public_key) VALUES (?, ?, ?)'
        ).run(reply.camp.id, reply.camp.name ?? null, reply.camp.signing_public_key ?? null)
      }

      // Trust the Host as a device, locally. Found by the integration harness
      // (test/integration/harnessAutomerge.js), and a real defect rather than
      // a fixture gap: evaluateAuthenticate re-checks the RECEIVING side's own
      // `devices` row for the peer and admits only an AUTHORIZED one, but a
      // peer with no row gets one inserted as 'pending' and is then refused.
      // Without this, sync would work for the length of this join (admitPeer
      // bootstraps this session) and then never again after a restart, in one
      // direction, with nothing logged on the Host. Every earlier test seeded
      // this row by hand, which is exactly why nothing caught it.
      if (reply.host_device_id) {
        db.prepare(
          "INSERT OR REPLACE INTO devices (id, name, authorized_at, pairing_status) VALUES (?, ?, ?, 'authorized')"
        ).run(reply.host_device_id, 'Main computer', new Date().toISOString())
      }

      // The other half of mutual admission, and the subtlest step in the flow
      // (Stage 5 finding 4: a node only sends to peers that authenticated to
      // IT, so one-way admission means nothing moves in either direction).
      //
      // The Host cannot authenticate to us by the ordinary route: every token
      // it can issue is Ed25519-signed by its own key and verified against
      // `camps.signing_public_key`, which arrives IN the document we are
      // waiting for. So the joining device admits the Host on the strength of
      // the login it just completed against that Host's real user table —
      // the same human trust anchor (typed code, director approval, PIN) the
      // op-log's full_sync already relied on. See transport.js's admitPeer for
      // the full argument and its misuse boundary.
      node.admitPeer(hostPeerId)

      return { status: 'ok', token: reply.token, userId: reply.userId, role: reply.role, camp: reply.camp ?? null }
    },

    /** The last step, and the one the whole design turns on: wait for the camp
     * to arrive IN THE DOCUMENT. `null` means the bounded wait elapsed — the
     * device is authenticated but has no camp, and the caller must say so and
     * discard the session rather than leaving a half-identity behind. */
    async waitForCamp() {
      // Deliberately NOT short-circuited on `campRow(db)` being present: login
      // wrote that row a moment ago, so an early return here would report
      // success before a single byte of the camp's actual data had arrived —
      // exactly the "logged in but empty" state this wait exists to catch.
      // `campArrived` is resolved only from onProjected, i.e. only once a
      // received document has actually merged and projected.
      return withTimeout(campArrived.promise, documentWaitMs, null)
    },

    async stop() {
      await node.stop()
    },
  }

  return { status: 'started', session }
}
