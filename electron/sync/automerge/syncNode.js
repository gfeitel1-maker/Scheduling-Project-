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

// Starts a transport node and wires it to `doc`/`db`. Returns a handle that
// exposes the current doc and the same lifecycle/broadcast surface as
// transport.js, so callers don't need to reach into the raw transport.
//
// `doc` is the caller's starting Automerge document (e.g. from
// createEmptyDoc() or loadDoc(savedBytes)); this module owns mutating it from
// here on via the internal `state.doc` reference.
export async function startSyncNode({ deviceId, db, doc, onProjected } = {}) {
  const state = { doc }

  async function handleReceived(bytes, { fromPeerId }) {
    const before = A.getHeads(state.doc)
    let incoming
    try {
      incoming = A.load(bytes)
    } catch {
      // Untrusted peer input: a malformed Automerge binary must not crash
      // this node (design doc's "what must NOT be trusted" section).
      return
    }
    state.doc = A.merge(state.doc, incoming)
    const after = A.getHeads(state.doc)
    if (JSON.stringify(before) === JSON.stringify(after)) return

    projectAll(db, state.doc)
    onProjected?.(state.doc)
    await transport.broadcastDoc(A.save(state.doc), { exceptPeerId: fromPeerId })
  }

  const transport = await startTransport({ deviceId, onDocReceived: handleReceived })

  return {
    peerId: transport.peerId,
    getPeers: transport.getPeers,
    getMultiaddrs: transport.getMultiaddrs,
    dial: transport.dial,
    // Exposed for adversarial-input tests (sending raw bytes that are not a
    // valid Automerge doc); not part of the normal edit/broadcast flow.
    sendDocTo: transport.sendDocTo,
    getDoc: () => state.doc,
    // Apply a local change (via the caller's own A.change/applyWrite), project
    // it locally, and broadcast the new bytes to every connected peer.
    applyLocal: async (newDoc) => {
      state.doc = newDoc
      projectAll(db, state.doc)
      await transport.broadcastDoc(A.save(state.doc))
    },
    stop: transport.stop,
  }
}
