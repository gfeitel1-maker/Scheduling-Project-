// Owns "the current sync starter" across a db swap. A starter closes over one db and one deviceId,
// so a project switch / backup restore must stop the old node and build a fresh starter for the
// new db; every makeHandlers call site reads its sync options from handlerOptions() so the
// starter callbacks cannot be wired differently at different sites.
export function createSyncStarterHolder(makeStarter) {
  let starter = makeStarter()
  let starting = null
  let replacing = null

  function start() {
    // A failed replace is reported by its own caller (swap rolls back); a joined start must not
    // turn it into a second, unhandled rejection.
    if (replacing) return replacing.then(() => starting, () => undefined)
    const p = starter.start()
    starting = p
    const clear = () => { if (starting === p) starting = null }
    p.then(clear, clear)
    return p
  }

  async function shutdown() {
    const punch = starter.shutdownPunch().catch(() => {})
    const node = starter.getNode()
    if (node) {
      try { await node.stop() } catch (err) { console.error(`automerge sync: stopping the node failed: ${err?.message ?? err}`) }
    }
    await punch
  }

  // A start in flight on the old db would land a second node after this returns, so it settles first.
  // Re-checked in a loop: a start kicked off while waiting must settle too.
  // A start() arriving during the replace joins it instead of starting the old starter.
  function replace() {
    if (replacing) return replacing
    const p = doReplace()
    replacing = p
    const clear = () => { if (replacing === p) replacing = null }
    p.then(clear, clear)
    return p
  }

  // Pair again runs a temporary node on this device's peer identity, so the persistent one stops
  // first; the next start() (join finished, or cancelled) builds a fresh starter.
  async function stop() {
    while (starting) {
      try { await starting } catch { /* start() reports its own failures */ }
    }
    await shutdown()
    starter.releaseBroadcaster()
    starter = makeStarter()
  }

  async function doReplace() {
    while (starting) {
      try { await starting } catch { /* start() reports its own failures */ }
    }
    await shutdown()
    starter.releaseBroadcaster()
    starter = makeStarter()
    replacing = null
    start()
  }

  // One project switch at a time: a second would interleave its node stop/start and db close with the first.
  let switching = false
  function acquireSwitch() {
    if (switching) {
      throw Object.assign(new Error('Another project switch is already in progress.'), { code: 'project_switch_in_progress' })
    }
    switching = true
    return () => { switching = false }
  }

  // commit() repoints the caller's db/deviceId; revert() undoes it. A throw from build() leaves the
  // caller on the old project with its node running again. `held` means the caller already holds the switch lock.
  async function swap({ commit, revert, build, held = false }) {
    const release = held ? () => {} : acquireSwitch()
    try {
      commit()
      try {
        await replace()
        return await build()
      } catch (err) {
        revert()
        try { await replace() } catch (rollbackErr) {
          console.error(`automerge sync: restarting the node after a failed switch failed: ${rollbackErr?.message ?? rollbackErr}`)
        }
        throw err
      }
    } finally {
      release()
    }
  }

  return {
    getNode: () => starter.getNode(),
    start,
    shutdown,
    replace,
    swap,
    acquireSwitch,
    handlerOptions: () => ({
      getAutomergeSyncNode: () => starter.getNode(),
      getAutomergeStartupAttempted: () => starter.getStartupAttempted(),
      getRelayReservationRefused: () => starter.getRelayReservationRefused(),
      getPortMappingStatus: () => starter.getPortMappingStatus?.() ?? null,
      onCampBootstrapped: () => start(),
      onCampJoined: () => start(),
      retrySync: () => start(),
      stopSync: () => stop(),
    }),
  }
}
