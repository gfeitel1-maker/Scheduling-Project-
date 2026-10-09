// Owns "the current sync starter" across a db swap. A starter closes over one db and one deviceId,
// so a project switch / backup restore must stop the old node and build a fresh starter for the
// new db; every makeHandlers call site reads its sync options from handlerOptions() so the
// starter callbacks cannot be wired differently at different sites.
export function createSyncStarterHolder(makeStarter) {
  let starter = makeStarter()
  let starting = null

  function start() {
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
  async function replace() {
    try { await starting } catch { /* start() reports its own failures */ }
    await shutdown()
    starter.releaseBroadcaster()
    starter = makeStarter()
    start()
  }

  // commit() repoints the caller's db/deviceId; revert() undoes it. A throw from build() leaves the
  // caller on the old project with its node running again.
  async function swap({ commit, revert, build }) {
    commit()
    try {
      await replace()
      return build()
    } catch (err) {
      revert()
      await replace()
      throw err
    }
  }

  return {
    getNode: () => starter.getNode(),
    start,
    shutdown,
    replace,
    swap,
    handlerOptions: () => ({
      getAutomergeSyncNode: () => starter.getNode(),
      getAutomergeStartupAttempted: () => starter.getStartupAttempted(),
      getRelayReservationRefused: () => starter.getRelayReservationRefused(),
      onCampBootstrapped: () => starter.start(),
      onCampJoined: () => starter.start(),
      retrySync: () => starter.start(),
    }),
  }
}
