// T359 slice 3 (docs/adr/2026-10-09-router-port-mapping-on-rung-1.md): the lifecycle around
// createPortMapper for the libp2p TCP listener. start() clears a mapping a crashed run left behind, then
// maps; stop() removes the mapping (bounded, so it can never hold up quit); a LAN address or default
// gateway change unmaps from the old gateway if it still answers and maps on the new one. Only
// syncStarter's strict SHORESH_PUNCH_ENABLED === 'true' block builds one.
//
// The router-reported external IP and port live inside this module and leave it in one shape only: the
// '/ip4/<ip>/tcp/<port>' string handed to the signed, encrypted gossip entry (getMappedAddress). The
// status the director's flag reads is { status, lease, reason? } and never carries either.
import { createPortMapper, PERMANENT_LEASE_REASON } from './portMapping.js'

export const NETWORK_CHECK_MS = 30_000
export const QUIT_UNMAP_MS = 3_000

export function createPortMappingLifecycle({
  localPort, portInUse = false, deps, grantStore, log = () => {}, onChange = () => {},
  discoveryMs, callMs, checkMs = NETWORK_CHECK_MS, quitUnmapMs = QUIT_UNMAP_MS,
}) {
  let latest = null
  let signature = null
  let starting = null
  let stopped = false
  let checking = false
  let timer = null

  const mapper = createPortMapper({
    localPort, portInUse, deps, grantStore, log, discoveryMs, callMs,
    onChange: (result) => { if (!stopped) { latest = result; onChange() } },
  })

  async function networkSignature() {
    try {
      const lan = deps.lanInterfaces().map((i) => `${i.address}/${i.netmask}`).sort()
      return JSON.stringify([lan, (await deps.defaultGatewayIp()) ?? null])
    } catch {
      return null
    }
  }

  async function begin() {
    signature = await networkSignature()
    const result = await mapper.start()
    if (stopped) { await mapper.unmap(); return }
    latest = result
    onChange()
  }

  function start() {
    if (starting) return starting
    stopped = false
    starting = begin()
    starting.then(() => {
      if (stopped || !(checkMs > 0)) return
      timer = setInterval(checkNetwork, checkMs)
      timer.unref?.()
    })
    return starting
  }

  async function checkNetwork() {
    if (stopped || checking || !starting) return
    checking = true
    try {
      await starting
      const next = await networkSignature()
      if (stopped || next === signature) return
      signature = next
      latest = null
      onChange()
      const result = await mapper.map()
      if (stopped) { await mapper.unmap(); return }
      latest = result
      onChange()
    } finally {
      checking = false
    }
  }

  async function stop() {
    stopped = true
    if (timer) clearInterval(timer)
    timer = null
    let bound
    const timeout = new Promise((resolve) => { bound = setTimeout(resolve, quitUnmapMs); bound.unref?.() })
    const teardown = (async () => {
      try { await starting } catch { /* the mapper never throws */ }
      await mapper.unmap()
    })()
    await Promise.race([teardown, timeout])
    clearTimeout(bound)
    latest = null
  }

  const getStatus = () => {
    if (!latest) return null
    const status = { status: latest.status, lease: latest.lease ?? null }
    if (latest.status === 'permanent-lease') status.reason = PERMANENT_LEASE_REASON
    return status
  }

  const getMappedAddress = () =>
    latest && (latest.status === 'mapped' || latest.status === 'permanent-lease') && latest.externalIp && latest.externalPort
      ? `/ip4/${latest.externalIp}/tcp/${latest.externalPort}`
      : null

  return { start, stop, checkNetwork, getStatus, getMappedAddress }
}
