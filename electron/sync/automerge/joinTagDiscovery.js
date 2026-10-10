// The Host's half of join-by-code discovery: advertise the code-derived join tag
// (joinCode.js's joinDiscoveryTag) ONLY while the director's Add-a-device window
// is open, and stop the moment it closes or the code changes.
//
// docs/adr/2026-09-15-ephemeral-join-secret-for-wan-discovery.md (ACCEPTED) §2:
// the secret is window-scoped, and the Host advertises its rendezvous key only
// during that window. Before this module nothing advertised the join tag at all —
// the joining device (joinSession.js) searched a tag no Host ever answered, so
// every join ended in "No camp answered that code".
//
// libp2p fixes its peerDiscovery services at construction, so this is ONE stable
// peerDiscovery service whose inner discovery (an mDNS instance scoped to the
// current join tag) is swapped by hand. Only the tag — a one-way scrypt of the
// code — ever reaches the wire; the code itself never does.
import { createMdnsDiscovery } from './discovery.js'
import { joinDiscoveryTag, normalizeJoinCode } from '../joinCode.js'

export function createJoinTagAdvertiser({ discoveryFor = (serviceTag) => createMdnsDiscovery({ serviceTag }) } = {}) {
  let components = null
  let running = false
  let tag = null
  let inner = null
  let chain = Promise.resolve()
  const target = new EventTarget()
  const forward = (evt) => target.dispatchEvent(new CustomEvent('peer', { detail: evt.detail }))

  // Serialized: a close racing an open must never leave a stale tag advertising.
  function reconcile() {
    chain = chain.then(async () => {
      const want = running && components && tag ? tag : null
      if (inner && inner.tag === want) return
      if (inner) {
        const old = inner
        inner = null
        old.service.removeEventListener('peer', forward)
        try { await old.service.stop() } catch (err) {
          console.error(`join tag: stopping the previous advertisement failed: ${err?.message ?? err}`)
        }
      }
      if (want) {
        const service = discoveryFor(want)(components)
        service.addEventListener('peer', forward)
        inner = { tag: want, service }
        await service.start()
      }
    })
    return chain
  }

  function factory(c) {
    components = c
    target.start = () => { running = true; return reconcile() }
    target.stop = () => { running = false; return reconcile() }
    return target
  }

  return {
    factory,
    /** The live join code, or null when the window is closed. Never stored; only its tag. */
    setCode(code) {
      const normalized = code == null ? null : normalizeJoinCode(String(code))
      tag = normalized ? joinDiscoveryTag(normalized) : null
      return reconcile()
    },
    advertisedTag: () => inner?.tag ?? null,
  }
}
