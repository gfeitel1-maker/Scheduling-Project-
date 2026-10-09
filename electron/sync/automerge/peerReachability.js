// "This device cannot reach its camp" — the flag for an honest device that was offline through a
// revoke. Its peers have since rotated the LAN tag and the rendezvous namespace, so it cannot find
// them and has to pair again on the camp's network.
//
// The signal is deliberately conservative, because the device cannot tell "my discovery secrets
// are stale" from "every other device is switched off": it fires only when the sync node is
// running, the camp has at least one other paired device, and NO camp peer has been reachable
// (authenticated) for a whole bound. A long bound keeps a camp whose other laptops are simply
// closed overnight from being told to re-pair after a few minutes.
export const PEERS_UNREACHABLE_AFTER_MS = 6 * 60 * 60 * 1000

export function createPeerReachabilityTracker({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, onThresholdCrossed, thresholdMs = PEERS_UNREACHABLE_AFTER_MS } = {}) {
  let since = null
  let timer = null

  function reset() {
    since = null
    if (timer !== null) clearTimer(timer)
    timer = null
  }

  return {
    update({ nodeRunning, otherDeviceCount, peerReachable }) {
      if (!nodeRunning || !(otherDeviceCount > 0) || peerReachable) {
        reset()
        return false
      }
      if (since === null) {
        since = now()
        timer = setTimer(() => { timer = null; onThresholdCrossed?.() }, thresholdMs)
        timer?.unref?.()
      }
      return now() - since >= thresholdMs
    },
    stop: reset,
  }
}
