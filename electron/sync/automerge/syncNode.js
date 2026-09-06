// Stage 4c (docs/work/plans/2026-09-06-stage4-libp2p-transport-design.md):
// the glue between transport.js (opaque bytes) and the document/projection
// layer built in Stages 1-3 (electron/automerge/campDocument.js,
// electron/automerge/projector.js). This is the first place Stage 4's code
// touches Automerge or SQLite — isolated here so it can be reviewed
// separately from libp2p plumbing.
//
// On each received frame: A.merge the incoming bytes into the held doc; if
// heads advanced, projectAll into SQLite and re-broadcast to every OTHER
// connected peer (mirrors test-cr4-live.mjs's except-self broadcast, which is
// what lets a 3+ peer LAN mesh converge without a full connection graph).
import * as A from '@automerge/automerge'
import { startTransport } from './transport.js'
import { projectAll } from '../../automerge/projector.js'
import { synthesizeOpEvents } from './docDiffEvents.js'
import { evaluateAuthenticate } from '../../auth/connectionAuth.js'

// Starts a transport node and wires it to `doc`/`db`. Returns a handle that
// exposes the current doc and the same lifecycle/broadcast surface as
// transport.js, so callers don't need to reach into the raw transport.
//
// `doc` is the caller's starting Automerge document (e.g. from
// createEmptyDoc() or loadDoc(savedBytes)); this module owns mutating it from
// here on via the internal `state.doc` reference.
//
// `onRemoteOps` (Stage 5c, docs/work/plans/2026-09-06-stage5-live-wiring-design.md § 3): fired
// with (events, { fromPeerId }) once per received frame that actually advanced the doc AND
// projected successfully — deliberately AFTER projectAll, never before and never on a projection
// failure. Firing before projectAll would race the renderer's reload against SQLite still being
// mid-write; firing on a projection failure would tell the renderer "reload, fresh data is here"
// while SQLite is actually stuck at last-good, which is worse than saying nothing. `events` is
// whatever synthesizeOpEvents (docDiffEvents.js) computed between the pre-merge and post-merge
// heads — the caller (main.js) is responsible for sanitizing/forwarding them over IPC; this module
// only computes and hands them off. Wrapped in try/catch so a consumer's own throw can never break
// sync or escape as an unhandled rejection — sync must keep converging regardless of what a push-
// event listener does with what it's handed.
export async function startSyncNode({ deviceId, db, doc, onProjected, onProjectionError, onRemoteOps } = {}) {
  const state = { doc }

  async function handleReceived(bytes, { fromPeerId }) {
    let incoming
    try {
      incoming = A.load(bytes)
    } catch {
      // Untrusted peer input: a malformed Automerge binary must not crash
      // this node (design doc's "what must NOT be trusted" section).
      return
    }
    const before = A.getHeads(state.doc)
    const merged = A.merge(state.doc, incoming)
    if (JSON.stringify(before) === JSON.stringify(A.getHeads(merged))) return // nothing new
    state.doc = merged

    // Project into SQLite. A merged doc can be valid CRDT state yet violate a
    // domain invariant the projector rejects — e.g. a child entity referencing
    // a parent another peer concurrently deleted (the Stage-2 rules-layer
    // boundary; projector.js:projectAll throws ATOMICALLY, leaving SQLite at
    // its last-good state). That throw must NOT crash the node or escape as an
    // unhandled rejection, and must NOT poison the node silently: the merged
    // doc stays as the CRDT truth we keep and relay, the SQLite divergence is
    // surfaced (onProjectionError + logged) for the Stage-2 rules layer to
    // repair, and sync continues. See docs/adr/2026-09-06 rules-layer section.
    try {
      projectAll(db, state.doc)
      onProjected?.(state.doc)
      // Only synthesize/fire push events once SQLite actually reflects the merged doc — the
      // renderer re-reads SQLite on these events, so they must never lead the projection.
      if (onRemoteOps) {
        try {
          const events = synthesizeOpEvents(state.doc, before, A.getHeads(state.doc), { deviceId: fromPeerId ?? null })
          if (events.length > 0) onRemoteOps(events, { fromPeerId })
        } catch (err) {
          console.error(`syncNode: onRemoteOps consumer threw (non-fatal, sync continues): ${err?.message ?? err}`)
        }
      }
    } catch (err) {
      onProjectionError?.(err, state.doc, fromPeerId)
      console.error(
        `syncNode: projection failed for a merged doc from ${fromPeerId ?? 'unknown peer'} — ` +
          `SQLite left at last-good, doc kept as CRDT truth, rules-layer repair pending: ${err?.message ?? err}`
      )
    }

    // Relay the merged doc regardless of local projection outcome: it is valid
    // CRDT state, and withholding it would make this node a convergence
    // dead-end. Guard so a transport error can't escape as an unhandled
    // rejection either.
    try {
      await transport.broadcastDoc(A.save(state.doc), { exceptPeerId: fromPeerId })
    } catch (err) {
      console.error(`syncNode: re-broadcast after receive failed (non-fatal): ${err?.message ?? err}`)
    }
  }

  // Stage 5d-1 (docs/adr/2026-09-06-libp2p-membership-mapping.md §1/§3): the
  // admission decision for the auth-over-libp2p `authenticate` message —
  // implements the ADR's "reconnect" flow only (an already-paired,
  // already-logged-in device presenting a live token). `pairing_request`/
  // `login` are 5d-2 and are not handled here; any other message type is
  // already rejected by authGate.js before this is even called.
  async function onAuthenticate(msg) {
    const result = evaluateAuthenticate(db, { token: msg.token, device_id: msg.device_id })
    return result.ok ? { ok: true } : { ok: false, reason: result.reason }
  }

  const transport = await startTransport({ deviceId, onDocReceived: handleReceived, onAuthenticate })

  return {
    peerId: transport.peerId,
    getPeers: transport.getPeers,
    getMultiaddrs: transport.getMultiaddrs,
    dial: transport.dial,
    authenticateWith: transport.authenticateWith,
    isPeerAuthenticated: transport.isPeerAuthenticated,
    // Exposed for adversarial-input tests (sending raw bytes that are not a
    // valid Automerge doc); not part of the normal edit/broadcast flow.
    sendDocTo: transport.sendDocTo,
    getDoc: () => state.doc,
    // Apply a local change (via the caller's own A.change/applyWrite), project
    // it locally, and broadcast the new bytes to every connected peer.
    applyLocal: async (newDoc) => {
      state.doc = newDoc
      try {
        projectAll(db, state.doc)
        onProjected?.(state.doc)
      } catch (err) {
        onProjectionError?.(err, state.doc, null)
        console.error(`syncNode: local projection failed — SQLite left at last-good: ${err?.message ?? err}`)
      }
      await transport.broadcastDoc(A.save(state.doc))
    },
    stop: transport.stop,
  }
}
